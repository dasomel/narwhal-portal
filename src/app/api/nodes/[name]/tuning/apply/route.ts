import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { runHostJob } from "@/lib/k8s-job-runner"
import { getNodeDetail } from "@/lib/k8s-client"
import { buildJobScript, parseVerification, type ApplyTarget } from "@/lib/tuning-commands"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

export const dynamic = "force-dynamic"

interface ApplyBody {
  items: ApplyTarget[]
}

const VALID_KINDS = new Set([
  "kernel-param", "kernel-module", "ulimit", "package",
  "swap-off", "service-enable", "ethtool", "tuning-script",
])

const CONTROL_PLANE_TAINT = "node-role.kubernetes.io/control-plane"
const MASTER_TAINT = "node-role.kubernetes.io/master"

function validateBody(body: unknown): ApplyBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid body" }
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items) || items.length === 0) return { error: "items required" }
  if (items.length > 50) return { error: "too many items (max 50)" }
  for (const it of items) {
    if (!it || typeof it !== "object") return { error: "invalid item" }
    const kind = (it as { kind?: unknown }).kind
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return { error: `invalid kind: ${String(kind)}` }
  }
  return { items: items as ApplyTarget[] }
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

  // H-4: Reject control-plane nodes — refuse if any taint key matches
  // node-role.kubernetes.io/control-plane.
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
  const parsed = validateBody(body)
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  // #55: pre-validate the allowlisted targets up front so a bad item still yields a
  // 400 (buildJobScript throws on anything outside tuning-commands.ts's per-kind
  // allowlist). The actual script that runs is built again, from these same targets,
  // inside runHostJob — the raw shell interface it used to accept was removed, so
  // there is no separate "script" value to smuggle a difference through here.
  try {
    buildJobScript(parsed.items)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  const kinds = parsed.items.map((i) => (i as { kind?: string }).kind ?? "?")
  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "node.tuning.apply",
    source: "kubernetes",
    resource: { kind: "Node", name: nodeName },
    title: `Node tuning apply started: ${nodeName}`,
    description: `${parsed.items.length} item(s): ${kinds.join(", ")}`,
  })

  try {
    const result = await runHostJob({
      nodeName,
      targets: parsed.items,
      label: "tuning",
      timeoutMs: 5 * 60_000,
    })
    // #55 item 6: re-read the actual resulting host state (parsed out of the Job's
    // own log markers, see buildVerifyCommand/parseVerification in tuning-commands.ts)
    // instead of trusting the apply command's exit code alone.
    const verification = parseVerification(result.logs, parsed.items)
    const verifiedOk = result.ok && verification.every((v) => v.ok)
    if (verifiedOk) {
      await completeOperation(ctx, `Node tuning apply completed: ${nodeName}`, `Job ${result.jobName}`)
    } else {
      await failOperation(
        ctx,
        `Node tuning apply failed: ${nodeName}`,
        `Job ${result.jobName}${result.ok ? " (post-apply verification mismatch)" : ""}`,
      )
    }
    return NextResponse.json({
      ok: verifiedOk,
      jobName: result.jobName,
      logs: result.logs,
      verification,
      appliedBy: session.user.email ?? session.user.name ?? "unknown",
      appliedAt: new Date().toISOString(),
    }, { status: verifiedOk ? 200 : 500 })
  } catch (e) {
    await failOperation(ctx, `Node tuning apply failed: ${nodeName}`, (e as Error).message)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
