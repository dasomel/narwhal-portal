export interface PodSummary {
  name: string
  namespace: string
  phase: string            // Running | Pending | Succeeded | Failed | Unknown
  ready: string            // "2/2"
  restarts: number
  node: string
  age: string              // ISO creationTimestamp
  images: string[]
}

export interface PodListResponse {
  pods: PodSummary[]
}

export interface PodDetail {
  name: string
  namespace: string
  phase: string
  podIP: string
  node: string
  qosClass: string
  serviceAccount: string
  createdAt: string
  labels: Record<string, string>
  owner: { kind: string; name: string } | null
  containers: {
    name: string
    image: string
    ready: boolean
    restarts: number
    state: string          // running | waiting:<reason> | terminated:<reason>
    requests: { cpu?: string; memory?: string }
    limits: { cpu?: string; memory?: string }
  }[]
  conditions: { type: string; status: string; reason?: string; message?: string }[]
}

export interface ResourceEvent {
  type: string             // Normal | Warning
  reason: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
}

export interface ResourceEventsResponse {
  events: ResourceEvent[]
}

export interface DoraDeployment {
  app: string
  namespace: string
  revision: string         // short sha (7)
  deployedAt: string
  status: "Succeeded" | "Failed"
}

export interface DoraPerApp {
  app: string
  namespace: string
  deploys: number
  lastDeployedAt: string | null
  leadTimeHours: number | null   // avg commit->deploy for this app's recent deploys
}

export interface DoraMetrics {
  period: "7d"
  deployFrequency: number        // per day
  totalDeploys: number
  leadTimeHours: number | null   // REAL lead time: gitea commit ts -> argocd deployedAt (avg)
  changeFailureRate: number      // % of deployments in period whose sync phase Failed
  mttrMinutes: number | null     // avg resolved-alert episode duration over 7d
  dailyDeploys: { date: string; count: number }[]   // 7 entries, oldest first, date "MM-DD"
  perApp: DoraPerApp[]           // sorted by deploys desc, max 15
  recent: DoraDeployment[]       // newest first, max 20
}
