import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps } from "@/lib/argocd"
import { getAlerts } from "@/lib/alertmanager"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { getVisibilityScope, namespaceMatchesScope } from "@/lib/role-filter"
import type { ArgoCDApp, HeroIncident, HeroAction, HeroMode, MascotState } from "@/types/api"
import type { TimelineEvent } from "@/app/api/events/route"
import type { MyAppsResponse, MyAppsAlert } from "@/types/my-apps"

export const dynamic = "force-dynamic"

// ---------------------------------------------------------------------------
// Simple hash for group list (cache key component)
// ---------------------------------------------------------------------------

function hashGroups(groups: string[]): string {
  const sorted = [...groups].sort().join(",")
  let h = 0
  for (let i = 0; i < sorted.length; i++) {
    h = (h * 31 + sorted.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Scoped hero builder — pure function, no external fetches
// ---------------------------------------------------------------------------

interface RawAlert {
  labels: Record<string, string>
  annotations: Record<string, string>
  status: { state: string }
  startsAt: string
}

function buildScopedHero(
  apps: ArgoCDApp[],
  alerts: MyAppsAlert[]
): { mode: HeroMode; mascot: MascotState; title: string; subtitle: string; incidents: HeroIncident[] } {
  const criticalAlerts = alerts.filter((a) => a.labels.severity === "critical")
  const warningAlerts = alerts.filter((a) => a.labels.severity !== "critical")
  const degradedApps = apps.filter(
    (a) => a.healthStatus === "Degraded" || a.healthStatus === "Missing"
  )
  const outOfSyncApps = apps.filter((a) => a.syncStatus === "OutOfSync")

  let mode: HeroMode
  let mascot: MascotState

  if (criticalAlerts.length >= 1 || degradedApps.length >= 1) {
    mode = "radar"
    mascot = "critical"
  } else if (warningAlerts.length >= 1 || outOfSyncApps.length >= 1) {
    mode = "radar"
    mascot = "warning"
  } else {
    mode = "summary"
    mascot = "healthy"
  }

  // Build incidents
  const incidents: HeroIncident[] = []

  for (let i = 0; i < criticalAlerts.length; i++) {
    const alert = criticalAlerts[i]
    incidents.push(alertToIncident(alert as RawAlert, i))
  }
  for (const app of degradedApps) {
    incidents.push(appToIncident(app, "critical"))
  }
  for (let i = 0; i < warningAlerts.length; i++) {
    const alert = warningAlerts[i]
    incidents.push(alertToIncident(alert as RawAlert, criticalAlerts.length + i))
  }
  for (const app of outOfSyncApps) {
    incidents.push(appToIncident(app, "warning"))
  }

  incidents.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  // Subtitle — fact-based English strings; frontend can override via i18n
  let title: string
  let subtitle: string

  if (mascot === "healthy") {
    title = "All calm in deep water"
    subtitle =
      apps.length === 0
        ? "No apps in your scope"
        : `All ${apps.length} of your app${apps.length !== 1 ? "s" : ""} are calm`
  } else if (mascot === "critical") {
    title = "Deep trouble"
    const parts: string[] = []
    if (criticalAlerts.length) parts.push(`${criticalAlerts.length} critical alert${criticalAlerts.length !== 1 ? "s" : ""}`)
    if (degradedApps.length) parts.push(`${degradedApps.length} of your app${degradedApps.length !== 1 ? "s" : ""} degraded`)
    subtitle = parts.join(" · ")
  } else {
    title = "Shallow ripples"
    const parts: string[] = []
    if (warningAlerts.length) parts.push(`${warningAlerts.length} warning${warningAlerts.length !== 1 ? "s" : ""}`)
    if (outOfSyncApps.length) parts.push(`${outOfSyncApps.length} of your app${outOfSyncApps.length !== 1 ? "s" : ""} ${outOfSyncApps.length === 1 ? "is" : "are"} drifting`)
    subtitle = parts.join(" · ")
  }

  return { mode, mascot, title, subtitle, incidents: incidents.slice(0, 5) }
}

function alertToIncident(alert: RawAlert, idx: number): HeroIncident {
  const severity = alert.labels.severity === "critical" ? "critical" : "warning"
  const name = alert.labels.alertname ?? "Alert"
  const actions: HeroAction[] = [
    {
      id: "investigate",
      label: "Investigate",
      requiresRole: null,
      href: null,
      mutationEndpoint: null,
      mutationBody: null,
    },
  ]
  if (alert.annotations.runbook_url) {
    actions.push({
      id: "runbook",
      label: "Runbook",
      requiresRole: null,
      href: alert.annotations.runbook_url,
      mutationEndpoint: null,
      mutationBody: null,
    })
  }
  actions.push({
    id: "silence",
    label: "Silence",
    requiresRole: "developer",
    href: null,
    mutationEndpoint: "/api/alerts/silence",
    mutationBody: { alertname: name, duration: 60 },
  })
  return {
    id: `my-alert-${name}-${idx}`,
    severity,
    kind: "alert",
    title: name,
    detail: alert.annotations.summary ?? alert.annotations.description ?? alert.labels.instance ?? "",
    source: { type: "alert", ref: name },
    actions,
    timestamp: alert.startsAt,
  }
}

function appToIncident(app: ArgoCDApp, severity: "warning" | "critical"): HeroIncident {
  const isDegraded = app.healthStatus === "Degraded" || app.healthStatus === "Missing"
  const kind = isDegraded ? "app-degraded" : "app-drift"
  return {
    id: `my-app-${kind}-${app.name}`,
    severity,
    kind,
    title: `${app.name} ${isDegraded ? `(${app.healthStatus})` : "out of sync"}`,
    detail: `Sync: ${app.syncStatus} · Health: ${app.healthStatus}`,
    source: { type: "argocd", ref: app.name },
    actions: [
      {
        id: "sync",
        label: "Sync",
        requiresRole: "developer",
        href: null,
        mutationEndpoint: "/api/argocd/sync",
        mutationBody: { appName: app.name },
      },
    ],
    timestamp: app.lastSyncedAt ?? new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Scoped events builder from raw apps + alerts
// ---------------------------------------------------------------------------

function buildScopedEvents(
  rawApps: Awaited<ReturnType<typeof getArgoApps>>,
  alerts: MyAppsAlert[],
  scope: { namespaces: string[]; argocdProjects: string[] }
): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const app of rawApps) {
    const proj = app.spec.project ?? "default"
    const ns = app.spec.destination?.namespace ?? app.metadata.namespace ?? "default"
    const inScope =
      scope.argocdProjects.includes(proj) ||
      namespaceMatchesScope(ns, scope.namespaces)
    if (!inScope) continue

    for (const h of app.status.history ?? []) {
      events.push({
        id: `my-deploy-${app.metadata.name}-${h.id}`,
        type: "deploy",
        title: app.metadata.name,
        description: `Deployed revision ${h.revision?.slice(0, 7) ?? "unknown"}`,
        timestamp: h.deployedAt,
        severity: "success",
      })
    }

    if (app.status.operationState?.finishedAt) {
      const phase = app.status.operationState.phase ?? ""
      events.push({
        id: `my-sync-${app.metadata.name}`,
        type: "sync",
        title: app.metadata.name,
        description: `Sync ${phase.toLowerCase()}: ${app.status.operationState.message ?? ""}`.trim(),
        timestamp: app.status.operationState.finishedAt,
        severity: phase === "Succeeded" ? "info" : phase === "Failed" ? "error" : "warning",
      })
    }
  }

  for (const alert of alerts) {
    events.push({
      id: `my-alert-evt-${alert.labels.alertname}-${alert.startsAt}`,
      type: "alert",
      title: alert.labels.alertname ?? "Alert",
      description: alert.annotations.summary ?? alert.annotations.description ?? "",
      timestamp: alert.startsAt,
      severity: alert.labels.severity === "critical" ? "error" : "warning",
    })
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return events.slice(0, 50)
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<MyAppsResponse | { error: string }>> {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Extract user identity for cache key
  const userSub =
    (session.user as { sub?: string }).sub ??
    (session.user as { id?: string }).id ??
    "unknown"
  const sessionGroups: string[] = session.groups ?? []
  const sessionTeams: string[] = session.teams ?? []
  const groupsHash = hashGroups([...sessionGroups, ...sessionTeams.map((t) => `team:${t}`)])
  const cacheKey = `my-apps:${userSub}:${groupsHash}`

  // Try cache first
  const cached = await cacheGet<MyAppsResponse>(cacheKey)
  if (cached) return NextResponse.json(cached)

  // Resolve scope
  const scopeResult = getVisibilityScope(sessionGroups, sessionTeams)
  const scope = {
    groups: scopeResult.groups,
    namespaces: scopeResult.namespaces,
    argocdProjects: scopeResult.argocdProjects,
    hasMapping: scopeResult.hasMapping,
  }

  // Empty scope — return minimal response immediately
  if (!scope.hasMapping) {
    const emptyHero = buildScopedHero([], [])
    const response: MyAppsResponse = {
      scope,
      scopedApps: [],
      scopedAlerts: [],
      scopedEvents: [],
      hero: emptyHero,
      generatedAt: new Date().toISOString(),
    }
    await cacheSet(cacheKey, response, 15)
    return NextResponse.json(response)
  }

  try {
    // Fan out in parallel
    const [rawAppsResult, rawAlertsResult] = await Promise.allSettled([
      getArgoApps(),
      getAlerts(),
    ])

    const rawApps = rawAppsResult.status === "fulfilled" ? rawAppsResult.value : []
    const rawAlerts = rawAlertsResult.status === "fulfilled" ? rawAlertsResult.value : []

    // Filter apps to scope
    const scopedApps: ArgoCDApp[] = rawApps
      .filter((a) => {
        const proj = a.spec.project ?? "default"
        const ns = a.spec.destination?.namespace ?? a.metadata.namespace ?? "default"
        return (
          scope.argocdProjects.includes(proj) ||
          namespaceMatchesScope(ns, scope.namespaces)
        )
      })
      .map((a) => ({
        name: a.metadata.name,
        namespace: a.spec.destination?.namespace ?? a.metadata.namespace ?? "default",
        project: a.spec.project ?? "default",
        syncStatus: (a.status.sync.status as ArgoCDApp["syncStatus"]) ?? "Unknown",
        healthStatus: (a.status.health.status as ArgoCDApp["healthStatus"]) ?? "Progressing",
        revision:
          a.status.sync.revision?.slice(0, 7) ??
          a.status.history?.at(-1)?.revision?.slice(0, 7) ??
          null,
        lastSyncedAt:
          a.status.operationState?.finishedAt ??
          a.status.history?.at(-1)?.deployedAt ??
          null,
      }))

    // Filter alerts to scope namespaces
    const scopedAlerts: MyAppsAlert[] = rawAlerts
      .filter((a) => {
        const ns = a.labels.namespace ?? a.labels.exported_namespace ?? ""
        // Include if no namespace label (cluster-wide) or namespace matches scope
        return !ns || namespaceMatchesScope(ns, scope.namespaces)
      })
      .map((a) => ({
        labels: a.labels,
        annotations: a.annotations,
        startsAt: a.startsAt,
      }))

    // Build scoped events from raw data (before ArgoCDApp mapping)
    const scopedEvents = buildScopedEvents(rawApps, scopedAlerts, scope)

    // Build scoped hero
    const hero = buildScopedHero(scopedApps, scopedAlerts)

    const response: MyAppsResponse = {
      scope,
      scopedApps,
      scopedAlerts,
      scopedEvents,
      hero,
      generatedAt: new Date().toISOString(),
    }

    await cacheSet(cacheKey, response, 15)
    return NextResponse.json(response)
  } catch (err) {
    console.error("[api/my-apps]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
