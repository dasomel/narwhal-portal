import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps } from "@/lib/argocd"
import { getAlerts } from "@/lib/alertmanager"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { alertVisible, appVisible, getEffectiveScope } from "@/lib/scope"

export const dynamic = "force-dynamic"

export interface TimelineEvent {
  id: string
  type: "deploy" | "alert" | "sync"
  title: string
  description: string
  timestamp: string
  severity: "info" | "warning" | "error" | "success"
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const sinceParam = searchParams.get("since")

  // Validate since param — must be ISO8601 if provided
  let sinceDate: Date | null = null
  if (sinceParam) {
    const parsed = new Date(sinceParam)
    if (isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "Invalid since value. Must be ISO8601 timestamp." },
        { status: 400 }
      )
    }
    sinceDate = parsed
  }

  // The timeline was assembled from EVERY ArgoCD application and EVERY alert, and
  // handed to anyone with a session. Deploy history names services, revisions and
  // when they last changed; alerts name what is failing and where. Both are scoped
  // in /api/my-apps already, so this route was the way around that.
  const scope = await getEffectiveScope(session)

  // The cache key has to carry the scope. It was the single literal
  // "events:timeline" holding a fully-rendered result, so once filtering exists,
  // whoever warmed the cache would be serving their view to everyone behind them —
  // a narrower defect than no filtering at all, and a much harder one to notice.
  const cacheKey = `events:timeline:${scope.fingerprint}`
  if (!sinceDate) {
    const cached = await cacheGet<TimelineEvent[]>(cacheKey)
    if (cached) return NextResponse.json(cached)
  }

  try {
    const [apps, alerts] = await Promise.all([getArgoApps(), getAlerts()])

    const events: TimelineEvent[] = []

    // ArgoCD deploy history
    for (const app of apps) {
      const inScope = appVisible(
        app.spec.project ?? "default",
        app.spec.destination?.namespace ?? app.metadata.namespace ?? "default",
        scope,
      )
      if (!inScope) continue

      for (const h of app.status.history ?? []) {
        events.push({
          id: `deploy-${app.metadata.name}-${h.id}`,
          type: "deploy",
          title: `${app.metadata.name}`,
          description: `Deployed revision ${h.revision?.slice(0, 7) ?? "unknown"}`,
          timestamp: h.deployedAt,
          severity: "success",
        })
      }

      // Sync status events
      if (app.status.operationState?.finishedAt) {
        const phase = app.status.operationState.phase ?? ""
        events.push({
          id: `sync-${app.metadata.name}`,
          type: "sync",
          title: `${app.metadata.name}`,
          description: `Sync ${phase.toLowerCase()}: ${app.status.operationState.message ?? ""}`.trim(),
          timestamp: app.status.operationState.finishedAt,
          severity: phase === "Succeeded" ? "info" : phase === "Failed" ? "error" : "warning",
        })
      }
    }

    // Alertmanager alerts
    alerts
      .filter((alert) => alertVisible(alert.labels, scope))
      .forEach((alert, idx) => {
        events.push({
          id: `alert-${alert.labels.alertname}-${alert.startsAt}-${idx}`,
          type: "alert",
          title: alert.labels.alertname ?? "Alert",
          description: alert.annotations.summary ?? alert.annotations.description ?? "",
          timestamp: alert.startsAt,
          severity: alert.labels.severity === "critical" ? "error" : "warning",
        })
    })

    // Sort descending by timestamp
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Apply since filter after sort
    const filtered = sinceDate
      ? events.filter((e) => new Date(e.timestamp).getTime() > sinceDate!.getTime())
      : events

    const result = filtered.slice(0, 50)

    // Only cache the unfiltered result
    if (!sinceDate) {
      await cacheSet(cacheKey, result, 15)
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("[api/events]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
