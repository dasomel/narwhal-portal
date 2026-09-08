import { NextResponse } from "next/server"

import { auth, getActorId } from "@/lib/auth"
import { getNodeDetail } from "@/lib/k8s-client"
import { issueTuningApproval, validateTuningItems } from "@/lib/tuning-approval"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

const CONTROL_PLANE_TAINT = "node-role.kubernetes.io/control-plane"
const MASTER_TAINT = "node-role.kubernetes.io/master"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
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
  if (!detail) return NextResponse.json({ error: "Node not found" }, { status: 404 })
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
  try {
    const items = validateTuningItems(
      body && typeof body === "object" ? (body as { items?: unknown }).items : undefined,
    )
    const issued = issueTuningApproval({ nodeName, items, actor: getActorId(session) })
    return NextResponse.json({
      approval: issued.approval,
      resolvedInvocation: {
        resolutionId: issued.artifact.resolutionId,
        tool: issued.artifact.tool,
        toolContractVersion: issued.artifact.toolContractVersion,
        target: issued.artifact.resolvedTarget,
        arguments: issued.artifact.normalizedResolvedArguments,
        canonicalizationVersion: issued.artifact.canonicalizationVersion,
        normalizedInvocationVersion: issued.artifact.normalizedInvocationVersion,
        invocationDigest: issued.artifact.invocationDigest,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
