import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getEvents } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export interface AuditEntry {
  id: string
  timestamp: string
  firstTimestamp: string
  actor: string
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
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const cacheKey = "governance:audit"
  const cached = await cacheGet<AuditEntry[]>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const events = await getEvents()
    const entries: AuditEntry[] = events
      .filter((e) => e.lastTimestamp || e.firstTimestamp)
      .sort((a, b) => new Date(b.lastTimestamp ?? b.firstTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? a.firstTimestamp ?? 0).getTime())
      .slice(0, 100)
      .map((e, i) => ({
        id: `audit-${i}`,
        timestamp: e.lastTimestamp ?? e.firstTimestamp ?? "",
        firstTimestamp: e.firstTimestamp ?? "",
        actor: e.reportingComponent || e.source?.component || "system",
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
    return NextResponse.json({ error: "Failed to fetch audit logs" }, { status: 500 })
  }
}
