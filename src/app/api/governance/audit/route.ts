import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getEvents } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

// portal#16: this endpoint surfaces Kubernetes Events, an operational signal —
// NOT the Kubernetes Audit trail (request-level actor/verb/resource/response
// records from apiserver audit logging). `reportingComponent` names the event
// *producer* (e.g. a controller or kubelet); it is never a user/API-actor
// identity, and must not be relabeled as one. Every entry carries
// `evidenceKind: "operational-event"` so a caller can't mistake this feed for
// audit evidence. See narwhal docs/common/compliance-hardening.md for the
// cluster's real apiserver audit-log status (configured, not yet portal-ingested).
export interface OperationalEventEntry {
  id: string
  evidenceKind: "operational-event"
  timestamp: string
  firstTimestamp: string
  reportingComponent: string
  action: string
  resource: string
  kind: string
  name: string
  namespace: string
  detail: string
  type: string
  count: number
  source: string
}

export async function GET() {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  // New key: entries cached under the old "governance:audit" key carry the removed `actor`
  // field and lack evidenceKind/reportingComponent, so they must not be served after deploy.
  const cacheKey = "governance:operational-events:v2"
  const cached = await cacheGet<OperationalEventEntry[]>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const events = await getEvents()
    const entries: OperationalEventEntry[] = events
      .filter((e) => e.lastTimestamp || e.firstTimestamp)
      .sort((a, b) => new Date(b.lastTimestamp ?? b.firstTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? a.firstTimestamp ?? 0).getTime())
      .slice(0, 100)
      .map((e, i) => ({
        id: `event-${i}`,
        evidenceKind: "operational-event",
        timestamp: e.lastTimestamp ?? e.firstTimestamp ?? "",
        firstTimestamp: e.firstTimestamp ?? "",
        // Producer identity only — never presented as a user/API actor.
        reportingComponent: e.reportingComponent || e.source?.component || "unknown",
        action: e.reason,
        resource: `${e.involvedObject.kind}/${e.involvedObject.name}`,
        kind: e.involvedObject.kind,
        name: e.involvedObject.name,
        namespace: e.involvedObject.namespace ?? e.namespace ?? "",
        detail: e.message,
        type: e.type ?? "Normal",
        count: e.count ?? 1,
        source: [e.source?.component, e.source?.host].filter(Boolean).join(" / "),
      }))

    await cacheSet(cacheKey, entries, 15)
    return NextResponse.json(entries)
  } catch (err) {
    console.error("[governance/audit]", err)
    return NextResponse.json({ error: "Failed to fetch operational events" }, { status: 500 })
  }
}
