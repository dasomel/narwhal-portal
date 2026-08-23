import { NextResponse } from "next/server"
import { getClusterMetrics, getNodeMetrics } from "@/lib/prometheus"
import { auth } from "@/lib/auth"

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
export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

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
