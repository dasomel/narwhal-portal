// API response shape contracts — consumed directly by frontend components.
// Phase A: hero, argocd, alerts (severity filter), events (since filter).

export type HeroMode = "summary" | "radar"
export type MascotState = "healthy" | "warning" | "critical" | "loading"

export interface HeroResponse {
  mode: HeroMode
  mascot: MascotState
  summary: {
    nodes: { ready: number; total: number }
    pods: { running: number; total: number }
    cpu: number           // 0-100
    memory: number        // 0-100
    syncedAgo: string | null  // e.g. "2m"
  }
  incidents: HeroIncident[]    // max 5, sorted critical-first then by timestamp desc
  incidentTotalCount: number   // unfiltered total
  copy: {
    title: string          // from i18n, pre-picked server-side
    subtitle: string       // fact line
  }
  generatedAt: string      // ISO8601
}

export interface HeroIncident {
  id: string
  severity: "warning" | "critical"
  kind: "alert" | "app-drift" | "app-degraded" | "node-pressure"
  title: string
  detail: string
  source: { type: "alert" | "argocd" | "node"; ref: string }
  actions: HeroAction[]
  timestamp: string        // ISO8601
}

export interface HeroAction {
  id: "investigate" | "silence" | "runbook" | "sync" | "rollback" | "cordon" | "drain"
  label: string
  requiresRole: "cluster-admin" | "developer" | null  // null = all roles
  href: string | null        // external jump (e.g. runbook URL)
  mutationEndpoint: string | null  // internal POST target (e.g. /api/argocd/sync)
  mutationBody: Record<string, unknown> | null  // POST body; client spreads as-is
}

export interface ArgoCDResponse {
  summary: { synced: number; outOfSync: number; degraded: number; total: number }
  apps: ArgoCDApp[]
}

export interface ArgoCDApp {
  name: string
  namespace: string
  project: string
  syncStatus: "Synced" | "OutOfSync" | "Unknown"
  healthStatus: "Healthy" | "Degraded" | "Progressing" | "Missing" | "Suspended"
  revision: string | null
  lastSyncedAt: string | null
}

export interface ArgoCDSyncRequest {
  appName: string
}

export interface ArgoCDSyncResponse {
  ok: boolean
  app?: { name: string; syncStatus: string; revision: string | null }
  error?: string
}

// Phase B: platform status (PinkWard-style infra health -> capability impact).

export type ComponentStatus = "healthy" | "degraded" | "down" | "unknown"

export interface StatusComponent {
  id: string
  name: string
  category:
    | "control-plane"
    | "gitops"
    | "identity"
    | "registry"
    | "observability"
    | "storage"
    | "networking"
    | "database"
  status: ComponentStatus
  detail: string
  source: string
  impacts: string[]
}

export interface StatusIncident {
  id: string
  severity: "critical" | "warning"
  title: string
  component: string | null
  startsAt: string
  summary: string
}

export interface PlatformStatus {
  overall: ComponentStatus
  // Rule-based, ENGLISH-only one-liner (e.g. "2 component(s) degraded: apisix, harbor").
  // Not meant for direct display in the Korean UI — the frontend should build its own
  // i18n'd summary from `overall` + `components` + `incidents`, which are the source
  // of truth. Keep this field as a stable English fallback/log line only.
  summary: string
  nodes: { total: number; ready: number }
  components: StatusComponent[]
  incidents: StatusIncident[]
  generatedAt: string
}
