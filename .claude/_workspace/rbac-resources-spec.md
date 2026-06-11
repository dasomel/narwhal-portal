# Spec: Governance RBAC risk analysis + Resources tab enrichment

Shared contract. Both lanes follow these shapes EXACTLY. ABSOLUTE RULES for both lanes:
- NEVER run git checkout/restore/stash/commit or modify files outside your ownership list.
- If a file outside your list looks broken, IGNORE it and note it in your report.

## Feature A — RBAC tab: make it analyzable

### Extended API: GET /api/governance/rbac  (same path, response v2)
Fetch bindings AS TODAY plus BULK fetch of /apis/rbac.authorization.k8s.io/v1/clusterroles
and /roles, join rules by roleRef, classify risk. Never per-role roundtrips.

```ts
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
  riskReasons: string[]       // i18n-free English tokens: "cluster-admin", "wildcard-verbs",
                              // "wildcard-resources", "secrets-access", "escalation",
                              // "cluster-write", "namespace-write", "read-only", "role-not-found"
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
```
Risk classification (first match):
- critical: roleRef.name === "cluster-admin" OR (wildcardVerbs && wildcardResources) OR escalation
- high: scope==="cluster" && (writeAccess || secretsAccess || wildcardVerbs || wildcardResources)
- medium: writeAccess (namespace scope) OR (scope==="cluster" && role not found)
- low: everything else
Valkey cache 60s key `governance:rbac:v2`. BACKWARD COMPAT NOT needed (frontend updated in lockstep).

### Frontend (rbac-table.tsx + types)
- Top summary row: 6 stat cards — 전체 바인딩, 클러스터 범위, Critical, High, Medium, Low.
  Use severity color pattern from src/components/compliance/rbac-audit-table.tsx:52-58 /
  security severity-counters.
- Table: add 위험도 badge column (colored per severity) + on hover/title show riskReasons
  translated via i18n (map known tokens; unknown tokens shown raw). Add risk filter chips
  (전체/Critical/High/Medium/Low) alongside existing scope filter. Default sort: risk desc.
- Expandable row OR title tooltip showing ruleSummary flags (룰 수, 와일드카드, 시크릿 접근,
  쓰기 권한, 권한 상승) — pick the simpler: a small flags cell with icon badges (e.g. "R7 · *verbs · secrets").
- Keep matrix view as-is.

## Feature B — Resources tab enrichment

### Extended API: GET /api/governance/resources  (same path, response v2)
```ts
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
export interface ResourcesResponseV2 {
  namespaces: NamespaceUsageV2[]
  topCpuPods: TopPod[]        // top 10 by cpu usage, cluster-wide (exclude kube-*)
  topMemPods: TopPod[]        // top 10 by memory
  cluster: { cpuPercent: number; memPercent: number; totalPods: number; noRequestPods: number }
}
```
Implementation: reuse queryVector from src/lib/prometheus.ts.
- top pods: `topk(10, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",namespace!~"kube.*"}[5m])))` and the memory equivalent with container_memory_working_set_bytes.
- noRequestPods: from the SAME pod list the route already reads (k8s API) — count pods where some container lacks resources.requests.cpu or .memory. If route doesn't read pods today, list pods once via k8sFetch (all namespaces, single call) and aggregate.
- cluster: reuse getClusterMetrics() from src/lib/prometheus.ts.
Valkey cache 30s key `governance:resources:v2`.

### Frontend (resource-chart.tsx)
- Top: 4 stat cards — 클러스터 CPU 사용률, 메모리 사용률, 총 파드 수, requests 미설정 파드 수
  (미설정>0이면 amber 강조 + caption "거버넌스: 모든 파드에 requests 설정 권장").
- Keep namespace bar chart; enrich tooltip with absolute values (used/requested cores·GiB)
  and keep the click->drawer behavior ALREADY wired (do not break onNamespaceClick).
- Below: two-column grid "Top 10 CPU 파드" / "Top 10 메모리 파드" tables
  (네임스페이스, 파드, 사용량). Row click → open ResourceDetailDrawer for that namespace
  with the pod preselected: drawer gets a NEW optional prop `initialPodName?: string`
  (when set and present in pod list, auto-enter detail mode for it; clearing on close).
- Namespace table below chart (optional if space allows): ns, pods, cpu%, mem%, noRequestPods
  with amber badge when >0. If it makes the tab too long, skip — chart+cards+top tables suffice.
- All strings i18n ko/en.

## Lane ownership
- BACKEND lane: src/app/api/governance/rbac/route.ts, src/app/api/governance/resources/route.ts,
  src/lib/k8s-client.ts (append-only helpers if needed), src/lib/prometheus.ts (append-only if needed).
- FRONTEND lane: src/components/governance/rbac-table.tsx, rbac-graph.tsx (only if needed),
  resource-chart.tsx, resource-detail-drawer.tsx (ONLY the initialPodName prop addition),
  src/components/governance/types.ts (append new interfaces), src/lib/i18n.ts (keys only).
- Each lane: `npx tsc --noEmit` must pass for YOUR files; pre-existing errors in the other
  lane's files may appear mid-flight — list them, do NOT fix or revert other files.
- Report <200 words: files+line ranges, deviations, tsc result.
