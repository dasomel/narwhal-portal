# Spec: Governance click-to-detail + DORA stage-1 enrichment

Shared contract for backend & frontend lanes. Both MUST follow these shapes exactly.

## Feature 1 — Governance resource detail drawer

### New API: GET /api/k8s/pods?namespace=<ns>[&app=<argocd-app-name>]
Lists pods, optionally filtered by ArgoCD app (label `app.kubernetes.io/instance=<app>`;
if zero results with the label, fall back to all pods in the namespace).
```ts
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
export interface PodListResponse { pods: PodSummary[] }
```

### New API: GET /api/k8s/resource?kind=Pod&namespace=<ns>&name=<name>
Pod detail (only kind=Pod for now; 400 on other kinds).
```ts
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
```

### New API: GET /api/k8s/events?namespace=<ns>&name=<involvedObjectName>
K8s events for one object (last 50, newest first).
```ts
export interface ResourceEvent {
  type: string             // Normal | Warning
  reason: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
}
export interface ResourceEventsResponse { events: ResourceEvent[] }
```

All three routes: auth() session check (401), Valkey cache 10s key `k8s:pods:<ns>:<app>`,
`k8s:resource:<ns>:<name>`, `k8s:events:<ns>:<name>`; cache failure non-fatal.
Use existing k8s client helpers in src/lib/k8s-client.ts (extend it, don't duplicate config).

### Frontend
- New `src/components/governance/resource-detail-drawer.tsx`:
  - shadcn `Sheet` (right side, wide: sm:max-w-2xl), pattern copy from audit-table.tsx.
  - Props: `{ namespace: string; app?: string; open: boolean; onOpenChange(o: boolean): void }`.
  - Content: pod list (PodListResponse via TanStack Query) → click pod → detail view with Tabs:
    - 개요 tab: PodDetail (status badge, node, QoS, containers table w/ image+restarts+state+req/limits, conditions)
    - 로그 tab: reuse existing `PodLogsViewer` component (check its props in src/components/catalog/pod-logs-viewer.tsx)
    - 보안 tab: per-container image vuln summary via EXISTING /api/security/vulnerabilities?image=... (render severity counts; if route shape differs, adapt — read the route first)
    - 이벤트 tab: ResourceEventsResponse table
  - Back button from pod detail → pod list.
- Wire up:
  - `scorecard-table.tsx`: row click → drawer with {namespace, app: serviceName}; add cursor-pointer + hover style.
  - `resource-chart.tsx`: namespace bar/label click → drawer with {namespace} (recharts onClick).
- i18n: ALL new UI strings via src/lib/i18n.ts keys (ko + en). No hardcoded strings.

## Feature 2 — DORA stage 1

### Rewritten API: GET /api/governance/dora  (keep route path)
```ts
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
  changeFailureRate: number      // % of deployments in period whose sync phase Failed (from history + operationState)
  mttrMinutes: number | null     // avg resolved-alert episode duration over 7d (Prometheus ALERTS reconstruction)
  dailyDeploys: { date: string; count: number }[]   // 7 entries, oldest first, date "MM-DD"
  perApp: DoraPerApp[]           // sorted by deploys desc, max 15
  recent: DoraDeployment[]       // newest first, max 20
}
```
Implementation notes (backend lane):
- Deploys: ArgoCD `status.history` over 7d as today. status per history entry: ArgoCD history
  has no per-entry phase; mark latest entry "Failed" if app.status.operationState?.phase==="Failed", else "Succeeded".
- Lead time: for each history entry take `revision` (full sha); fetch commit timestamp from
  in-cluster Gitea API. Discover how the portal can reach Gitea: check src/lib for an existing
  gitea client or env (GITEA_URL etc. in narwhal cluster repo gitops/resources/narwhal-portal-k8s.yaml).
  The gitops repo is `narwhal-gitops` owned by `gitea-admin`, internal URL
  http://gitea-http.devtools.svc.cluster.local:3000. Public repo read may work WITHOUT auth —
  try `GET /api/v1/repos/gitea-admin/narwhal-gitops/git/commits/{sha}` unauthenticated first; if 401/403/404,
  return leadTimeHours: null (graceful). Cache per-sha lookups in Valkey 1h (`dora:commit:<sha>`).
  leadTime per deploy = deployedAt - commit.committer.date; clamp negatives to null; avg over valid samples.
- MTTR: Prometheus range query over 7d, step 5m: `max by (alertname, namespace) (ALERTS{alertstate="firing",severity!="none"})`.
  Reconstruct episodes (consecutive 1s); episodes that END within window count; mttr = avg episode duration minutes.
  Use existing prometheus client helper in src/lib (find it; the live/service-map features query prometheus already).
  On error → null.
- Whole response cached in Valkey 120s (`governance:dora:v2`).

### Frontend: rewrite src/components/governance/dora-metrics.tsx
- Top row: 4 stat cards — 배포 빈도(회/일), 리드 타임(커밋→배포, h or "—"), 변경 실패율(%), MTTR(분 or "—").
  Each card gets a one-line caption explaining the definition (i18n).
- Middle: 7-day deployment trend bar chart (recharts BarChart, dailyDeploys) — match styling of existing charts (resource-chart.tsx).
- Bottom: two-column grid: per-app table (앱/네임스페이스/배포수/리드타임) + recent deployments list (앱, sha 7자리 mono, 시각 relative, 상태 badge).
- Loading skeletons + empty states. i18n ko/en for everything.

## Verification expected from each lane
- `npx tsc --noEmit` passes.
- Backend lane: also `curl` is NOT possible locally — just ensure route compiles and logic guards nulls.
- Report: under 200 words, list of files changed with line ranges, any deviations from spec.
