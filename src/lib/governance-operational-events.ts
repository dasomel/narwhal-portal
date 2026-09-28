import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getEventsBounded } from "@/lib/k8s-client"
import { cacheGetWithMeta, cacheSet } from "@/lib/valkey"
import { cacheKeys, cacheTtl } from "@/lib/cache-keys"

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

export interface OperationalEventsResponse {
  items: OperationalEventEntry[]
  truncated: boolean
  evidenceKind: "operational-event"
  freshness: { source: "cache" | "live"; observedAt: string | null }
}

export async function getOperationalEventsResponse(): Promise<NextResponse> {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json({ error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, {
      status: gate.error === "unauthorized" ? 401 : 403,
    })
  }

  const key = cacheKeys.governanceOperationalEventsV3()
  try {
    const cached = await cacheGetWithMeta<Omit<OperationalEventsResponse, "freshness">>(key)
    if (cached) {
      return NextResponse.json({ ...cached.value, freshness: { source: "cache", observedAt: cached.cachedAt } })
    }
  } catch (err) {
    console.warn("[governance/events] Cache lookup failed:", err)
  }

  try {
    const { items: events, truncated } = await getEventsBounded()
    const items: OperationalEventEntry[] = events
      .filter((event) => event.lastTimestamp || event.firstTimestamp)
      .sort((a, b) => new Date(b.lastTimestamp ?? b.firstTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? a.firstTimestamp ?? 0).getTime())
      .slice(0, 100)
      .map((event, i) => ({
        id: `event-${i}`,
        evidenceKind: "operational-event",
        timestamp: event.lastTimestamp ?? event.firstTimestamp ?? "",
        firstTimestamp: event.firstTimestamp ?? "",
        reportingComponent: event.reportingComponent || event.source?.component || "unknown",
        action: event.reason,
        resource: `${event.involvedObject.kind}/${event.involvedObject.name}`,
        kind: event.involvedObject.kind,
        name: event.involvedObject.name,
        namespace: event.involvedObject.namespace ?? event.namespace ?? "",
        detail: event.message,
        type: event.type ?? "Normal",
        count: event.count ?? 1,
        source: [event.source?.component, event.source?.host].filter(Boolean).join(" / "),
      }))
    const value = { items, truncated, evidenceKind: "operational-event" as const }
    // A truncated page is known-incomplete, so it is re-listed rather than cached; complete pages are cached.
    if (!truncated) await cacheSet(key, value, cacheTtl("governanceOperationalEventsV3"))
    return NextResponse.json<OperationalEventsResponse>({ ...value, freshness: { source: "live", observedAt: new Date().toISOString() } })
  } catch (err) {
    console.error("[governance/events]", err)
    return NextResponse.json({ error: "Failed to fetch operational events" }, { status: 500 })
  }
}
