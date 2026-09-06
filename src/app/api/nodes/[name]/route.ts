import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getNodeDetail } from "@/lib/k8s-client"
import { getNodeMetrics, getNodePodCount } from "@/lib/prometheus"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // portal#33: node telemetry has no namespace/team dimension (see the
  // rationale in src/app/api/metrics/route.ts), so the applicable policy
  // is a role gate rather than getEffectiveScope/namespaceVisible — the same
  // requireRole(cluster-admin, developer, viewer) used by /api/cost,
  // /api/scorecards and /api/service-graph for other non-tenant-scoped reads.
  // This route previously accepted any authenticated session including guest.
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  const { name } = await params
  try {
    assertK8sNodeName(name)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }

  const [detail, nodeMetrics, podCount] = await Promise.allSettled([
    getNodeDetail(name),
    getNodeMetrics(),
    getNodePodCount(name),
  ])

  if (detail.status === "rejected" || !detail.value) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 })
  }

  const metrics = nodeMetrics.status === "fulfilled"
    ? nodeMetrics.value.find((n) => n.node === name)
    : null

  return NextResponse.json({
    ...detail.value,
    cpu: metrics?.cpu ?? { cores: null, usagePercent: null, status: "unavailable" },
    memory: metrics?.memory ?? { totalBytes: null, usagePercent: null, status: "unavailable" },
    disk: metrics?.disk ?? { totalBytes: null, usagePercent: null, status: "unavailable" },
    podCount: podCount.status === "fulfilled" ? podCount.value : null,
    metricsStatus: metrics?.status ?? "unavailable",
    evidenceSource: metrics?.evidenceSource ?? "none",
  })
}
