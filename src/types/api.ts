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
