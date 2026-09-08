import { NextResponse } from "next/server"
import { auth, getActorId } from "@/lib/auth"
import { runHostJob } from "@/lib/k8s-job-runner"
import { getNodeDetail } from "@/lib/k8s-client"
import { parseVerification, type ApplyTarget } from "@/lib/tuning-commands"
import {
  consumeTuningApproval,
  validateTuningItems,
  type TuningApprovalEnvelope,
} from "@/lib/tuning-approval"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

export const dynamic = "force-dynamic"

interface ApplyBody {
  items: ApplyTarget[]
  approval: TuningApprovalEnvelope
}

const CONTROL_PLANE_TAINT = "node-role.kubernetes.io/control-plane"
const MASTER_TAINT = "node-role.kubernetes.io/master"

function parseBody(body: unknown): ApplyBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid body" }
  const raw = body as { items?: unknown; approval?: unknown }
  let items: ApplyTarget[]
  try {
    items = validateTuningItems(raw.items)
  } catch (error) {
    return { error: (error as Error).message }
  }
  if (!raw.approval || typeof raw.approval !== "object") return { error: "approval required" }
  const approval = raw.approval as Partial<TuningApprovalEnvelope>
  const fields: Array<keyof TuningApprovalEnvelope> = [
    "approvalId",
    "resolutionId",
    "invocationDigest",
    "canonicalizationVersion",
    "approvedAt",
    "expiresAt",
  ]
  for (const field of fields) {
    if (typeof approval[field] !== "string" || approval[field] === "") {
      return { error: `invalid approval: ${field}` }
    }
  }
  return { items, approval: approval as TuningApprovalEnvelope }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { name: nodeName } = await params
  try {
    assertK8sNodeName(nodeName)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }

  const detail = await getNodeDetail(nodeName)
  if (!detail) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 })
  }
  const isControlPlane =
    (detail.taints ?? []).some((t) => t.key === CONTROL_PLANE_TAINT || t.key === MASTER_TAINT) ||
    detail.labels?.[CONTROL_PLANE_TAINT] !== undefined ||
    detail.labels?.[MASTER_TAINT] !== undefined
  if (isControlPlane) {
    return NextResponse.json(
      { error: "Forbidden", message: "Tuning Apply is not allowed on control-plane nodes" },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  const parsed = parseBody(body)
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  // portal#78: the side-effect boundary consumes a one-shot approval only after
  // recomputing the canonical resolved invocation from the concrete target/args.
  // Any changed target, changed argument, stale approval, unsupported c14n version,
  // or replay is rejected before beginOperation/runHostJob.
  const approvalCheck = await consumeTuningApproval({
    envelope: parsed.approval,
    nodeName,
    items: parsed.items,
    actor: getActorId(session),
  })
  if (!approvalCheck.ok) {
    return NextResponse.json(
      { error: "Approval rejected", reason: approvalCheck.reason },
      { status: 409 },
    )
  }

  const kinds = parsed.items.map((i) => (i as { kind?: string }).kind ?? "?")
  const evidence = {
    approvalId: parsed.approval.approvalId,
    resolutionId: approvalCheck.artifact.resolutionId,
    invocationDigest: approvalCheck.artifact.invocationDigest,
    canonicalizationVersion: approvalCheck.artifact.canonicalizationVersion,
    normalizedInvocationVersion: approvalCheck.artifact.normalizedInvocationVersion,
  }
  const evidenceText = `approval=${evidence.approvalId} resolution=${evidence.resolutionId} invocation=${evidence.invocationDigest}`
  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "node.tuning.apply",
    source: "kubernetes",
    resource: { kind: "Node", name: nodeName },
    title: `Node tuning apply started: ${nodeName}`,
    description: `${parsed.items.length} item(s): ${kinds.join(", ")} | ${evidenceText}`,
  })

  try {
    const result = await runHostJob({
      nodeName,
      targets: parsed.items,
      label: "tuning",
      timeoutMs: 5 * 60_000,
    })
    const verification = parseVerification(result.logs, parsed.items)
    const verifiedOk = result.ok && verification.every((v) => v.ok)
    if (verifiedOk) {
      await completeOperation(
        ctx,
        `Node tuning apply completed: ${nodeName}`,
        `Job ${result.jobName} | ${evidenceText}`,
      )
    } else {
      await failOperation(
        ctx,
        `Node tuning apply failed: ${nodeName}`,
        `Job ${result.jobName}${result.ok ? " (post-apply verification mismatch)" : ""} | ${evidenceText}`,
      )
    }
    return NextResponse.json({
      ok: verifiedOk,
      jobName: result.jobName,
      logs: result.logs,
      verification,
      evidence,
      appliedBy: session.user.email ?? session.user.name ?? "unknown",
      appliedAt: new Date().toISOString(),
    }, { status: verifiedOk ? 200 : 500 })
  } catch (e) {
    await failOperation(ctx, `Node tuning apply failed: ${nodeName}`, `${(e as Error).message} | ${evidenceText}`)
    return NextResponse.json({ error: (e as Error).message, evidence }, { status: 500 })
  }
}
