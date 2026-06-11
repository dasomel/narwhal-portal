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

export type RbacRisk = "critical" | "high" | "medium" | "low"
export interface RbacRuleSummary {
  ruleCount: number
  wildcardVerbs: boolean      // any rule verbs includes "*"
  wildcardResources: boolean  // any rule resources includes "*"
  secretsAccess: boolean      // resources includes "secrets" (any verb)
  writeAccess: boolean        // verbs intersect create|update|patch|delete|deletecollection
  escalation: boolean         // verbs/resources include bind|escalate|impersonate
}
export interface RbacBindingV2 {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  roleRef: { kind: string; name: string }
  subjects: { kind: string; name: string; namespace?: string }[]
  risk: RbacRisk
  riskReasons: string[]       // i18n-free English tokens
  ruleSummary: RbacRuleSummary | null   // null when referenced role not found
}
export interface RbacSummary {
  total: number
  clusterScope: number
  namespaceScope: number
  bySubjectKind: { user: number; group: number; serviceAccount: number }
  byRisk: { critical: number; high: number; medium: number; low: number }
}
export interface RbacResponseV2 { bindings: RbacBindingV2[]; summary: RbacSummary }

export interface NamespaceUsageV2 {
  namespace: string
  cpuPercent: number          // usage / requests * 100 (as today)
  memoryPercent: number
  podCount: number
  cpuUsedCores: number        // absolute, 3 decimals
  cpuRequestedCores: number
  memUsedBytes: number
  memRequestedBytes: number
  noRequestPods: number       // pods in ns with ANY container missing cpu+memory requests
}
export interface TopPod {
  namespace: string
  pod: string
  cpuCores: number            // current usage
  memBytes: number
}
export interface NoRequestPod {
  namespace: string
  pod: string
  containers: string[]
}
export interface ResourcesResponseV2 {
  namespaces: NamespaceUsageV2[]
  topCpuPods: TopPod[]        // top 10 by cpu usage, cluster-wide (exclude kube-*)
  topMemPods: TopPod[]        // top 10 by memory
  cluster: { cpuPercent: number; memPercent: number; totalPods: number; noRequestPods: number }
  noRequestPodsList: NoRequestPod[]
}
