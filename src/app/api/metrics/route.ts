import { NextResponse } from "next/server"
import { getClusterMetrics, getNodeMetrics } from "@/lib/prometheus"
import { requireRole } from "@/lib/auth"

export const dynamic = "force-dynamic"

// portal#33 requires distinguishing cluster-wide/global metrics from tenant-scoped
// telemetry before deciding whether this needs team/namespace scoping. Checked:
// getClusterMetrics/getNodeMetrics (src/lib/prometheus.ts) query only cluster- and
// node-level aggregates (overall CPU/memory %, node/pod counts, per-node capacity) —
// no per-namespace or per-workload breakdown, so nothing here is tenant data to leak.
// This is "system" visibility (see src/types/live.ts's LiveEventVisibility for the
// same concept applied to events) by construction, not by omission — if a
// namespace-scoped metric is ever added to this response, it needs the same
// getEffectiveScope/namespaceVisible gate the k8s/pods and k8s/resource routes use.
//
// "No tenant data" is not "no policy" though — the route previously accepted any
// authenticated session (guest included), unlike every other non-tenant-scoped read
// (/api/cost, /api/scorecards, /api/service-graph) which gates on
// requireRole(cluster-admin, developer, viewer). Matching that policy here so
// telemetry exposure is consistent across routes rather than accidentally the one
// exception.
export async function GET() {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    const [metrics, nodeMetrics] = await Promise.all([
      getClusterMetrics(),
      getNodeMetrics(),
    ])
    return NextResponse.json({ ...metrics, nodeMetrics })
  } catch (err) {
    console.error("[api/metrics]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
