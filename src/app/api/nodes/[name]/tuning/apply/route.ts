import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { runHostJob } from "@/lib/k8s-job-runner"
import { getNodeDetail } from "@/lib/k8s-client"
import { buildJobScript, type ApplyTarget } from "@/lib/tuning-commands"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

interface ApplyBody {
  items: ApplyTarget[]
}

const VALID_KINDS = new Set([
  "kernel-param", "kernel-module", "ulimit", "package",
  "swap-off", "service-enable", "ethtool", "tuning-script",
])

const CONTROL_PLANE_TAINT = "node-role.kubernetes.io/control-plane"

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
    (detail.taints ?? []).some((t) => t.key === CONTROL_PLANE_TAINT) ||
    detail.labels?.[CONTROL_PLANE_TAINT] !== undefined
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

  let script: string
  try {
    script = buildJobScript(parsed.items)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  // H-4: Audit log — who/when/which node/which kinds.
  console.info("[audit] tuning-apply", {
    actor: session.user.email ?? session.user.name ?? "unknown",
    role: session.user.role,
    nodeName,
    itemCount: parsed.items.length,
    kinds: parsed.items.map((i) => (i as { kind?: string }).kind ?? "?"),
    requestedAt: new Date().toISOString(),
  })

  try {
    const result = await runHostJob({
      nodeName,
      script,
      label: "tuning",
      timeoutMs: 5 * 60_000,
    })
    console.info("[audit] tuning-apply.result", {
      actor: session.user.email ?? session.user.name ?? "unknown",
      nodeName,
      jobName: result.jobName,
      ok: result.ok,
      finishedAt: new Date().toISOString(),
    })
    return NextResponse.json({
      ok: result.ok,
      jobName: result.jobName,
      logs: result.logs,
      appliedBy: session.user.email ?? session.user.name ?? "unknown",
      appliedAt: new Date().toISOString(),
    }, { status: result.ok ? 200 : 500 })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
