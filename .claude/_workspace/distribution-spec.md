# Spec: Governance "분산 배치" (Workload Distribution) tab

Shared contract. Both lanes follow shapes EXACTLY. ABSOLUTE RULES:
- NEVER run git checkout/restore/stash/commit. NEVER touch files outside your ownership list.
- If a file outside your list looks broken mid-flight, IGNORE it; note in report.
- This cluster has NO zone labels (topology.kubernetes.io/zone absent) — distribution is
  HOSTNAME-level only. Do NOT build zone-grouped axes; if zone is null treat all nodes as one group.

## API: GET /api/governance/distribution  (NEW)
Aggregate pod->node placement, per-workload replica spread, node balance, anti-affinity gaps.
```ts
export interface NodeLoad {
  node: string
  role: "control-plane" | "worker"
  podCount: number
  cpuPercent: number | null   // from prometheus node metrics if available, else null
  memPercent: number | null
}
export interface WorkloadSpread {
  namespace: string
  kind: string                // Deployment | StatefulSet | DaemonSet | ...
  name: string                // workload name (ReplicaSet collapsed to its Deployment)
  replicas: number            // running pod count for this workload
  nodes: { node: string; count: number }[]   // sorted desc by count
  distinctNodes: number
  concentrated: boolean       // replicas>=2 && distinctNodes===1
  hasAntiAffinity: boolean    // any pod has spec.affinity.podAntiAffinity
  hasTopologySpread: boolean  // any pod has spec.topologySpreadConstraints
  risk: "high" | "medium" | "low"
  // high: concentrated (multi-replica on single node)
  // medium: replicas>=2 && !hasAntiAffinity && !hasTopologySpread (spread by luck, no guarantee)
  // low: otherwise
}
export interface DistributionSummary {
  nodeCount: number
  workerCount: number
  totalPods: number
  // node balance: max-min pod count across WORKER nodes (control-plane excluded)
  podImbalance: number               // maxWorkerPods - minWorkerPods
  maxNode: { node: string; podCount: number } | null
  minNode: { node: string; podCount: number } | null
  concentratedWorkloads: number      // count risk==="high"
  unguardedWorkloads: number         // count risk==="medium"
  multiReplicaWorkloads: number      // replicas>=2 total
  controlPlaneWorkloadPods: number   // non-DaemonSet, non-static app pods running on control-plane nodes (leak indicator)
}
export interface DistributionResponse {
  summary: DistributionSummary
  nodes: NodeLoad[]            // sorted: workers first by podCount desc, then control-plane
  workloads: WorkloadSpread[]  // sorted by risk (high>medium>low) then replicas desc, cap 200
}
```
Backend implementation notes:
- One list call `/api/v1/pods` (all ns). For each pod read metadata.namespace, ownerReferences[0],
  spec.nodeName, spec.affinity?.podAntiAffinity, spec.topologySpreadConstraints.
- Collapse owner: if ownerReferences[0].kind === "ReplicaSet", derive Deployment name by stripping
  the trailing "-<hash>" segment (regex /-[a-f0-9]{8,10}$/), kind="Deployment". StatefulSet/DaemonSet/Job
  keep as-is. Pods with no owner -> kind="Pod", name=pod name (skip from workload risk unless replicas>=2 same name, which won't happen).
- Skip pods not Running for replica counting? No — count pods with a nodeName assigned (scheduled).
- Node roles + list from `/api/v1/nodes` (label node-role.kubernetes.io/control-plane present => control-plane).
- node cpu/mem percent: reuse existing prometheus helper getNodeMetrics() (src/lib/prometheus.ts) —
  match by node name; null if not found. Do NOT fail the whole route if prometheus errors (null out).
- controlPlaneWorkloadPods: pods on control-plane nodes whose owner kind is Deployment/StatefulSet/ReplicaSet
  (exclude DaemonSet and kube-system static pods like kube-apiserver/etcd/kube-vip/kube-scheduler/kube-controller-manager).
- Valkey cache 15s key `governance:distribution:v1`. auth() gate. Cache failure non-fatal.
- Append helpers to src/lib/k8s-client.ts if useful (e.g. getAllPodsForDistribution returning the
  minimal projected fields incl nodeName+owner+affinity flags). Do NOT modify existing exported fns.

## Frontend
Add a 6th-ish governance tab "분산 배치". The governance page (src/app/(dashboard)/governance/page.tsx)
currently renders tabs 스코어카드/RBAC/리소스/감사 로그/DORA 메트릭/트레이스. Insert "분산 배치"
after 리소스. New component src/components/governance/distribution-view.tsx ("use client", TanStack Query).

Layout:
1. 4 stat cards (reuse severity-card / stat-card styling already used in resource-chart.tsx):
   - 노드 부하 불균형 (podImbalance, caption "워커 노드 간 최대-최소 파드 수 격차"; amber if >=15)
   - 단일 노드 집중 워크로드 (concentratedWorkloads; rose if >0)
   - 분산 미보장 워크로드 (unguardedWorkloads; amber if >0; caption "anti-affinity/topologySpread 미설정")
   - 컨트롤플레인 누수 파드 (controlPlaneWorkloadPods; amber if >0; caption "워크로드가 마스터 노드에 배치됨")
2. Node load bars: per-node horizontal bar of podCount with cpu%/mem% labels; control-plane nodes
   visually separated (a subtle "control-plane" badge). Row click -> open ResourceDetailDrawer
   for that node's pods: drawer already lists pods by namespace+app; for node we need a node mode.
   SIMPLEST: do NOT reuse drawer for node (it's namespace-based). Instead a node row click expands
   inline OR links to existing /nodes/[name] page (href). USE the link to /nodes/<node> (already exists).
3. Workload x Node matrix (reuse the grid styling idea from rbac-graph.tsx, but simpler):
   - Only show workloads with replicas>=2 (multi-replica) — single-replica workloads can't be "spread".
   - Rows = workloads (risk badge + ns/name), columns = nodes that host any of them, cell = replica count.
   - Concentrated cell (all on one node) highlighted rose; spread = emerald. Cap columns to nodes in use.
   - If no multi-replica workloads, show empty-state "분산 대상(레플리카 2개 이상) 워크로드가 없습니다".
4. Risk table below: workloads sorted by risk, columns 위험도/네임스페이스/워크로드/종류/레플리카/노드 분포/보호.
   보호 column shows badges: AntiAffinity / TopologySpread present (emerald) or 없음 (muted).
   Tooltip/caption with remediation hint for high/medium.
- All strings i18n ko+en (useT from @/lib/i18n-client). Types: append to src/components/governance/types.ts.

## Lane ownership
- BACKEND: src/app/api/governance/distribution/route.ts (new), src/lib/k8s-client.ts (append only).
- FRONTEND: src/components/governance/distribution-view.tsx (new),
  src/app/(dashboard)/governance/page.tsx (add tab), src/components/governance/types.ts (append),
  src/lib/i18n.ts (keys only).
- Each lane runs `npx tsc --noEmit`; pre-existing cross-lane errors may appear — list, don't fix.
- Report <180 words: files+line ranges, deviations, tsc result. NO git.
