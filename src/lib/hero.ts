import { cacheGet, cacheSet } from "./valkey"
import { getAlerts } from "./alertmanager"
import { getArgoApps } from "./argocd"
import { getClusterMetrics } from "./prometheus"
import type {
  HeroResponse,
  HeroIncident,
  HeroAction,
  HeroMode,
  MascotState,
} from "@/types/api"

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

const COPY_HEALTHY = [
  "All calm in deep water",
  "Smooth sailing",
  "Nothing to surface",
]
const COPY_WARNING = [
  "Shallow ripples",
  "Something's bubbling up",
  "The depths are restless",
]
const COPY_CRITICAL = [
  "Deep trouble",
  "Emergency surfaced",
  "Storm below the surface",
]

/** Deterministic index: hash of cluster name + current UTC minute → stable within a minute. */
function pickIndex(state: MascotState, variants: string[]): number {
  const clusterName = process.env.CLUSTER_NAME ?? "narwhal"
  const minute = Math.floor(Date.now() / 60_000)
  let hash = 0
  const seed = `${clusterName}:${state}:${minute}`
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return hash % variants.length
}

function pickCopyTitle(state: MascotState): string {
  if (state === "critical") return COPY_CRITICAL[pickIndex(state, COPY_CRITICAL)]
  if (state === "warning") return COPY_WARNING[pickIndex(state, COPY_WARNING)]
  return COPY_HEALTHY[pickIndex(state, COPY_HEALTHY)]
}

// ---------------------------------------------------------------------------
// Incident builders
// ---------------------------------------------------------------------------

interface RawAlert {
  labels: Record<string, string>
  annotations: Record<string, string>
  status: { state: string }
  startsAt: string
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
    id: `alert-${name}-${idx}`,
    severity,
    kind: "alert",
    title: name,
    detail: alert.annotations.summary ?? alert.annotations.description ?? alert.labels.instance ?? "",
    source: { type: "alert", ref: name },
    actions,
    timestamp: alert.startsAt,
  }
}

interface RawArgoApp {
  metadata: { name: string; namespace?: string }
  spec: { project?: string; destination?: { namespace?: string } }
  status: {
    sync: { status: string; revision?: string }
    health: { status: string }
    operationState?: { finishedAt?: string }
    history?: Array<{ deployedAt: string }>
  }
}

function argoAppToIncident(app: RawArgoApp): HeroIncident {
  const syncStatus = app.status.sync.status
  const healthStatus = app.status.health.status
  const isDegraded = healthStatus === "Degraded" || healthStatus === "Missing"
  const severity: "warning" | "critical" = isDegraded ? "critical" : "warning"
  const kind = isDegraded ? "app-degraded" : "app-drift"
  const name = app.metadata.name

  const lastSyncedAt =
    app.status.operationState?.finishedAt ??
    app.status.history?.at(-1)?.deployedAt ??
    new Date().toISOString()

  const actions: HeroAction[] = []
  actions.push({
    id: "sync",
    label: "Sync",
    requiresRole: "developer",
    href: null,
    mutationEndpoint: "/api/argocd/sync",
    mutationBody: { appName: name },
  })
  // rollback: omitted until POST /api/argocd/rollback is implemented

  return {
    id: `app-${kind}-${name}`,
    severity,
    kind,
    title: `${name} ${isDegraded ? `(${healthStatus})` : "out of sync"}`,
    detail: `Sync: ${syncStatus} · Health: ${healthStatus}`,
    source: { type: "argocd", ref: name },
    actions,
    timestamp: lastSyncedAt,
  }
}

interface NodeCondition {
  type: string
  status: string
}

interface NodePressureInfo {
  name: string
  conditions: NodeCondition[]
}

function nodeToIncident(node: NodePressureInfo): HeroIncident {
  const pressureConditions = node.conditions
    .filter(
      (c) =>
        (c.type === "Ready" && c.status === "False") ||
        ((c.type === "MemoryPressure" || c.type === "DiskPressure" || c.type === "PIDPressure") &&
          c.status === "True")
    )
    .map((c) => c.type)

  return {
    id: `node-pressure-${node.name}`,
    severity: "critical",
    kind: "node-pressure",
    title: `Node pressure: ${node.name}`,
    detail: pressureConditions.join(", "),
    source: { type: "node", ref: node.name },
    // cordon/drain: omitted until POST /api/nodes/{cordon,drain} are implemented
    actions: [],
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Node pressure fetch (direct K8s API — no external lib dep)
// ---------------------------------------------------------------------------

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? ""
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""

async function getNodePressureNodes(): Promise<NodePressureInfo[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${K8S_API_SERVER}/api/v1/nodes`, {
      headers: {
        Authorization: `Bearer ${K8S_TOKEN}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return []

    const data = await res.json()
    const nodes: NodePressureInfo[] = (data.items ?? []).map(
      (n: {
        metadata: { name: string }
        status: { conditions?: Array<{ type: string; status: string }> }
      }) => ({
        name: n.metadata.name,
        conditions: n.status.conditions ?? [],
      })
    )

    return nodes.filter((node) =>
      node.conditions.some(
        (c) =>
          (c.type === "Ready" && c.status === "False") ||
          ((c.type === "MemoryPressure" || c.type === "DiskPressure" || c.type === "PIDPressure") &&
            c.status === "True")
      )
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// syncedAgo helper
// ---------------------------------------------------------------------------

function formatSyncedAgo(isoTimestamp: string | null): string | null {
  if (!isoTimestamp) return null
  const diffMs = Date.now() - new Date(isoTimestamp).getTime()
  if (diffMs < 0) return null
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return "<1m"
  if (diffMin < 60) return `${diffMin}m`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h`
  return `${Math.floor(diffH / 24)}d`
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

export async function buildHeroResponse(): Promise<HeroResponse> {
  // Fan out in parallel — cache failures handled inside each fetcher
  const [alertsResult, appsResult, metricsResult, pressureResult] =
    await Promise.allSettled([
      getAlerts(),
      getArgoApps(),
      getClusterMetrics(),
      getNodePressureNodes(),
    ])

  const alerts = alertsResult.status === "fulfilled" ? alertsResult.value : []
  const apps = appsResult.status === "fulfilled" ? appsResult.value : []
  const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null
  const pressureNodes = pressureResult.status === "fulfilled" ? pressureResult.value : []

  // Threshold logic
  const criticalAlerts = alerts.filter((a) => a.labels.severity === "critical")
  const warningAlerts = alerts.filter((a) => a.labels.severity !== "critical")
  const degradedApps = apps.filter(
    (a) =>
      a.status.health.status === "Degraded" || a.status.health.status === "Missing"
  )
  const outOfSyncApps = apps.filter((a) => a.status.sync.status === "OutOfSync")

  let mode: HeroMode
  let mascot: MascotState

  if (
    criticalAlerts.length >= 1 ||
    degradedApps.length >= 1 ||
    pressureNodes.length >= 1
  ) {
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
  const allIncidents: HeroIncident[] = [
    ...criticalAlerts.map((a, i) => alertToIncident(a, i)),
    ...degradedApps.map((a) => argoAppToIncident(a as RawArgoApp)),
    ...pressureNodes.map((n) => nodeToIncident(n)),
    ...warningAlerts.map((a, i) => alertToIncident(a, criticalAlerts.length + i)),
    ...outOfSyncApps.map((a) => argoAppToIncident(a as RawArgoApp)),
  ]

  // Sort: critical first, then by timestamp desc
  allIncidents.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  const incidentTotalCount = allIncidents.length
  const incidents = allIncidents.slice(0, 5)

  // Summary metrics
  const nodeTotal = metrics?.nodes?.total ?? 0
  const nodeReady = metrics?.nodes?.ready ?? 0
  const podTotal = metrics?.pods?.total ?? 0
  const podRunning = metrics?.pods?.running ?? 0
  const cpu = metrics?.cpu ?? 0
  const memory = metrics?.memory ?? 0

  // Last sync time: find the most recent operationState.finishedAt across all apps
  let latestSyncTs: string | null = null
  for (const app of apps) {
    const ts =
      (app as RawArgoApp).status.operationState?.finishedAt ??
      (app as RawArgoApp).status.history?.at(-1)?.deployedAt ??
      null
    if (ts && (!latestSyncTs || new Date(ts) > new Date(latestSyncTs))) {
      latestSyncTs = ts
    }
  }

  // Copy
  const title = pickCopyTitle(mascot)
  let subtitle: string
  if (mode === "summary") {
    subtitle = `${nodeTotal} nodes · ${podTotal} pods · 0 incidents`
  } else if (mascot === "critical") {
    const parts: string[] = []
    if (criticalAlerts.length) parts.push(`${criticalAlerts.length} critical alert${criticalAlerts.length > 1 ? "s" : ""}`)
    if (degradedApps.length) parts.push(`${degradedApps.length} app${degradedApps.length > 1 ? "s" : ""} degraded`)
    if (pressureNodes.length) parts.push(`${pressureNodes.length} node${pressureNodes.length > 1 ? "s" : ""} under pressure`)
    subtitle = parts.join(" · ")
  } else {
    const parts: string[] = []
    if (warningAlerts.length) parts.push(`${warningAlerts.length} warning${warningAlerts.length > 1 ? "s" : ""}`)
    if (outOfSyncApps.length) parts.push(`${outOfSyncApps.length} app${outOfSyncApps.length > 1 ? "s" : ""} drifting`)
    subtitle = parts.join(" · ")
  }

  return {
    mode,
    mascot,
    summary: {
      nodes: { ready: Math.round(nodeReady), total: Math.round(nodeTotal) },
      pods: { running: Math.round(podRunning), total: Math.round(podTotal) },
      cpu,
      memory,
      syncedAgo: formatSyncedAgo(latestSyncTs),
    },
    incidents,
    incidentTotalCount,
    copy: { title, subtitle },
    generatedAt: new Date().toISOString(),
  }
}

export async function getHeroResponse(): Promise<HeroResponse> {
  const cached = await cacheGet<HeroResponse>("hero:summary")
  if (cached) return cached

  const hero = await buildHeroResponse()

  // Cache failure is non-fatal — cacheSet swallows errors internally
  await cacheSet("hero:summary", hero, 10)

  return hero
}
