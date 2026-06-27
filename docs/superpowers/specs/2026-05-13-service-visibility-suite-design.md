# Service Visibility Suite — Design Spec

- **Date:** 2026-05-13
- **Project:** Narwhal IDP Portal
- **Author:** dasomel (brainstorming session, Claude Opus 4.7)
- **Scope:** Three additive features benchmarked against Backstage / Port / Headlamp / Crossplane

---

## 1. Goal

서비스(= ArgoCD Application + namespace) 단위 가시성을 3개 축으로 강화해 "내 서비스 상태가 어떤가" 한 화면으로 답하게 한다.

1. **Service Scorecards** — 서비스 품질을 0–100점 + tier(gold/silver/bronze/none)로 평가 (Port 패턴)
2. **Service Dependency Map** — Istio/Hubble 트래픽 실측에서 도출한 서비스 간 의존성 그래프 (Backstage 패턴)
3. **Cost Insights** — Prometheus 사용량 × 환경변수 단가로 namespace/service 비용 추정

세 기능은 한 스펙으로 묶는다. 같은 catalog entity를 공유하고 같은 UX(per-service tab + global view) 패턴을 따른다.

## 2. Non-Goals

- AI 어시스트 / LLM 진단 (별도 의사결정 필요)
- Helm/CRD generic explorer (Headlamp 외부 링크 유지)
- Backstage Plugin 시스템 도입 (현 모놀리식 유지)
- Kubecost/OpenCost 설치 (Prometheus-only로 시작, 향후 옵션 보강)
- 멀티클러스터 (단일 narwhal 클러스터 전제)

## 3. Architecture

### 3.1 Routing 배치

| 화면 | 위치 | 형태 |
|------|------|------|
| Scorecard 글로벌 | `/governance/scorecards` (탭 추가) | 모든 서비스 점수표, 정렬/필터 |
| Scorecard 서비스 | `/catalog/[name]?tab=quality` | 룰별 pass/fail + 조치 액션 |
| Service Map 글로벌 | `/architecture` (Services 토글 추가) | 의존성 그래프 |
| Service Map 서비스 | `/catalog/[name]?tab=dependencies` | in/out 호출 목록 |
| Cost 글로벌 | `/cost` (신규 톱레벨) | 클러스터/ns/service 분해 + 추이 |
| Cost 서비스 | `/catalog/[name]?tab=cost` | 서비스 비용 + top pods |

### 3.2 백엔드 구조

```
src/lib/
├── catalog.ts            ← 기존 CatalogService 확장 (scoreTier 등 필드)
├── scorecard.ts          ← 신규: rule loading + evaluator
├── service-graph.ts      ← 신규: PromQL → 인접리스트
└── cost.ts               ← 신규: PromQL → 자원사용 × 단가

src/app/api/
├── scorecards/route.ts
├── scorecards/[svc]/route.ts
├── scorecards/rules/route.ts
├── service-graph/route.ts
├── service-graph/[svc]/route.ts
├── cost/route.ts
├── cost/[svc]/route.ts
└── cost/trend/route.ts
```

### 3.3 데이터 흐름

```
GitOps YAML → ArgoCD sync → K8s ConfigMap narwhal-scorecard-rules
                                ↓ (cached 5min)
                          scorecard.ts evaluate(svc)
                                ↓
                          /api/scorecards/*

Prometheus(istio_requests_total | hubble_flows)
   → service-graph.ts (필터: self-call, healthcheck, low-rate, system)
   → /api/service-graph

Prometheus(container_cpu_usage_seconds_total + container_memory_working_set_bytes
           + kubelet_volume_stats_used_bytes)
   × ENV $/CPU-hr, $/GB-hr, $/Storage-GB-hr
   → /api/cost
```

### 3.4 클러스터 측 산출물 (narwhal/ 리포에서 처리)

- `gitops/resources/scorecard-rules.yaml` 신규 ConfigMap
- Prometheus recording rules: `scorecard:rules.yaml`, `cost:rules.yaml`
- 포털 Deployment env 추가: `COST_CPU_HOURLY`, `COST_MEM_GB_HOURLY`, `COST_STORAGE_GB_HOURLY`, `SCORECARD_CONFIGMAP_*`, `SERVICE_GRAPH_SOURCE`
- Istio/Hubble은 기존, 신규 설치 없음

---

## 4. Data Model

### 4.1 CatalogService 확장

```typescript
interface CatalogService {
  id: string                    // ArgoCD application name
  name: string
  namespace: string
  project: string               // ArgoCD project
  owner?: string                // annotation narwhal.io/owner
  runbookUrl?: string           // annotation narwhal.io/runbook
  syncStatus: "Synced" | "OutOfSync" | "Unknown"
  health: "Healthy" | "Degraded" | "Progressing" | "Missing" | "Unknown"
  lastSyncedAt?: string
  // 신규
  scoreTier?: "gold" | "silver" | "bronze" | "none"
  scoreValue?: number
}
```

Pod ↔ Service 매핑: `app.kubernetes.io/instance` 라벨 우선, fallback `app.kubernetes.io/name`.

### 4.2 Scorecard Rule (ConfigMap `narwhal-scorecard-rules`)

```yaml
version: 1
rules:
  - id: has-owner
    name: "소유자 지정"
    weight: 10
    check: { type: annotation, key: narwhal.io/owner, present: true }
  - id: has-runbook
    name: "Runbook 링크"
    weight: 5
    check: { type: annotation, key: narwhal.io/runbook, present: true }
  - id: pdb-defined
    name: "PodDisruptionBudget 설정"
    weight: 15
    check: { type: k8s-resource, kind: PodDisruptionBudget, minCount: 1 }
  - id: liveness-probe
    name: "Liveness Probe"
    weight: 15
    check: { type: pod-spec, jsonPath: "spec.containers[*].livenessProbe", required: true }
  - id: resource-limits
    name: "Resource Limits"
    weight: 10
    check: { type: pod-spec, jsonPath: "spec.containers[*].resources.limits.memory", required: true }
  - id: trusted-image
    name: "신뢰 Registry 이미지"
    weight: 15
    check:
      type: image-source
      allowedPrefixes: ["harbor.local.narwhal.internal/", "registry.k8s.io/"]
  - id: argocd-healthy
    name: "ArgoCD Synced & Healthy"
    weight: 15
    check: { type: argocd-status, requireSynced: true, requireHealthy: true }
  - id: network-policy
    name: "NetworkPolicy 존재"
    weight: 10
    check: { type: k8s-resource, kind: NetworkPolicy, minCount: 1, scope: namespace }
  - id: recent-deploy
    name: "최근 14일 내 배포"
    weight: 5
    check: { type: argocd-history, maxDaysSinceLastSync: 14 }
tiers: { gold: 90, silver: 70, bronze: 50 }
```

총합 = 100. Score = pass한 rule weight 합. **Tier 임계는 inclusive lower bound** — score ≥ 90 → gold, ≥ 70 → silver, ≥ 50 → bronze, < 50 → none. Check 타입은 6가지로 한정: `annotation`, `k8s-resource`, `pod-spec`, `image-source`, `argocd-status`, `argocd-history`.

```typescript
interface ScorecardEvaluation {
  serviceId: string
  score: number
  tier: "gold" | "silver" | "bronze" | "none"
  passed: { ruleId: string; weight: number }[]
  failed: { ruleId: string; weight: number; reason: string }[]
  evaluatedAt: string
}
```

### 4.3 Service Graph

PromQL 윈도 7d:

```promql
sum by (source_workload, destination_workload) (
  rate(istio_requests_total{
    source_workload!="unknown",
    destination_workload!="unknown",
    source_workload!=destination_workload
  }[7d])
)
```

Hubble fallback (mTLS 미적용 워크로드):

```promql
sum by (source, destination) (
  rate(hubble_flows_processed_total{verdict="FORWARDED"}[7d])
)
```

노이즈 필터:
- `rate < 0.01 req/s` 제거
- `destination_service_name` ∈ {`kubernetes`, `coredns`, `istiod`} 제외
- HTTP probe 경로(`/healthz`, `/readyz`, `/metrics`) 라벨 필터로 제외
- empty/`unknown` workload 제외

```typescript
interface ServiceNode {
  id: string
  namespace: string
  status: "healthy" | "degraded" | "unknown"
  scoreTier?: "gold" | "silver" | "bronze" | "none"
}

interface ServiceEdge {
  source: string
  destination: string
  requestRate: number      // req/s avg over window
  errorRate: number        // 0..1
  p95LatencyMs?: number | null
}
```

### 4.4 Cost

PromQL (1시간 평균 → 시간당 비용 환산):

```promql
# CPU cores
sum by (namespace, label_app_kubernetes_io_instance) (
  rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h])
  * on(pod, namespace) group_left(label_app_kubernetes_io_instance)
    kube_pod_labels
)

# Memory bytes
sum by (namespace, label_app_kubernetes_io_instance) (
  container_memory_working_set_bytes{container!="POD",container!=""}
  * on(pod, namespace) group_left(label_app_kubernetes_io_instance)
    kube_pod_labels
)

# Storage bytes (PVC)
sum by (namespace, persistentvolumeclaim) (
  kubelet_volume_stats_used_bytes
)
```

환산:
```
hourly = cores * COST_CPU_HOURLY
       + (mem_bytes / 1e9) * COST_MEM_GB_HOURLY
       + (storage_bytes / 1e9) * COST_STORAGE_GB_HOURLY
```

기본 단가(`.env`로 오버라이드):
- `COST_CPU_HOURLY=0.04`
- `COST_MEM_GB_HOURLY=0.005`
- `COST_STORAGE_GB_HOURLY=0.0001`

```typescript
interface CostBreakdown {
  scope: "cluster" | "namespace" | "service"
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number       // hourly * 720
}
```

### 4.5 캐시 TTL

| 데이터 | TTL | 키 |
|--------|-----|-----|
| Scorecard rule yaml | 5 min | `scorecard:rules` |
| 서비스별 평가 | 5 min | `scorecard:detail:{svc}` |
| 전체 점수 | 1 min | `scorecard:all:{owner}:{tier}` |
| Service graph cluster | 1 min | `graph:cluster:{window}:{ns}` |
| Service graph svc | 1 min | `graph:svc:{svc}:{window}` |
| Cost (any scope) | 5 min | `cost:{scope}:{id}` |
| Cost trend (30d) | 1 hour | `cost:trend:{scope}:{id}:{days}` |


---

## 5. UI Layout

기존 `service-detail.tsx`에 탭 추가: `Overview | Quality | Dependencies | Cost | Pods/Logs`.

### 5.1 `/governance/scorecards`
- 분포 도넛(Gold/Silver/Bronze/None) + 점수표(Tier · 서비스 · 점수 · Owner · 미통과 규칙)
- 필터: Tier multi-select, Owner select, 검색, 정렬(점수↓/점수↑/이름)
- 행 클릭 → `/catalog/[name]?tab=quality`
- 우상단: `[규칙 보기]` 모달 (ConfigMap yaml dump), `[CSV 내보내기]`

### 5.2 `/catalog/[name]?tab=quality`
- 상단 카드: tier 아이콘 + 점수/100 + 평가시각
- 통과 룰 리스트(✓ 아이콘 + 이름)
- 미통과 룰 리스트(✗ + 이름 + 실패 사유 + 가능한 경우 조치 액션 버튼: ArgoCD 딥링크 / runbook 가이드 / 관련 매니페스트 위치)
- 하단 "규칙 정의 보기" → 동일 모달

### 5.3 `/architecture` Services 토글
- 상단: `[ Infra ] [ Services ● ]` 토글, `윈도: 7d`, namespace 필터, error rate 임계 슬라이더
- 그래프: ReactFlow. 노드 색 = scorecard tier 테두리, 엣지 색 = 에러율(정상/노랑 1–5%/빨강 >5%)
- 노드 클릭 → 서비스 상세, 엣지 클릭 → req/s · err · p95 popover
- Empty state: "Istio/Hubble 메트릭 미수집 — 운영팀에 문의" + 클러스터 docs 링크

### 5.4 `/catalog/[name]?tab=dependencies`
- Inbound · Outbound 두 섹션
- 각 항목: 상대 서비스 + req/s + err% + p95
- "전체 맵에서 보기 →" → `/architecture?view=services&focus={svc}`

### 5.5 `/cost`
- 상단: 시간당/월 추정 + CPU/Mem/Storage 분해
- 30일 일별 추이 라인차트
- 단위 토글: Namespace / Service. 표: id · CPU $/h · Mem $/h · Stor $/h · 월
- 행 클릭 → 해당 ns의 service breakdown 또는 service 상세

### 5.6 `/catalog/[name]?tab=cost`
- 시간당/월 + CPU/Mem 분해
- 7일 일별 추이
- Top 5 Pod 표

### 5.7 공통
- shadcn/ui: `Card`, `Tabs`, `Table`, `Badge`, `Tooltip`, `Sheet`
- 차트: 기존 `resource-chart.tsx`와 동일 라이브러리(Recharts/Tremor — 구현 시 확정)
- 그래프: ReactFlow
- i18n: `ko`/`en` 동시 추가
- Loading: skeleton. Error: 카드 내 인라인. Empty: 안내 + 외부 docs 링크

---

## 6. API Surface

기존 컨벤션(`requireRole` 가드, valkey `cacheGet`/`cacheSet`, NextResponse JSON). 모든 라우트 RBAC = `cluster-admin | developer | viewer`.

### 6.1 Scorecards

```
GET /api/scorecards                       # 전체 (옵션: ?owner=&tier=)
GET /api/scorecards/[svc]                 # 단일
GET /api/scorecards/rules                 # 정의
```

```typescript
interface ScorecardListResponse {
  evaluatedAt: string
  rulesVersion: number
  totalServices: number
  tierCounts: { gold: number; silver: number; bronze: number; none: number }
  services: Array<{
    id: string; name: string; namespace: string; owner?: string
    score: number; tier: "gold" | "silver" | "bronze" | "none"
    failedRuleIds: string[]
  }>
}

interface ScorecardDetailResponse {
  service: { id: string; name: string; namespace: string; owner?: string }
  score: number
  tier: "gold" | "silver" | "bronze" | "none"
  evaluatedAt: string
  rules: Array<{
    id: string; name: string; description: string; weight: number
    status: "pass" | "fail"
    failReason?: string
    actionUrl?: string
  }>
}

interface ScorecardRulesResponse {
  version: number
  source: "configmap" | "fallback"
  loadedAt: string
  rules: unknown[]   // ConfigMap yaml 그대로
  tiers: { gold: number; silver: number; bronze: number }
}
```

### 6.2 Service Graph

```
GET /api/service-graph?window=7d&namespace=&minRate=0.01
GET /api/service-graph/[svc]?window=7d
```

```typescript
interface ServiceGraphResponse {
  window: string; generatedAt: string
  nodes: ServiceNode[]
  edges: ServiceEdge[]
}

interface ServiceGraphDetailResponse {
  serviceId: string
  inbound: Array<{ source: string; requestRate: number; errorRate: number; p95LatencyMs?: number | null }>
  outbound: Array<{ destination: string; requestRate: number; errorRate: number; p95LatencyMs?: number | null }>
}
```

window: `1h | 1d | 7d | 30d`.

### 6.3 Cost

```
GET /api/cost?scope=cluster|namespace|service
GET /api/cost/[svc]
GET /api/cost/trend?scope=&id=&days=
```

```typescript
interface CostResponse {
  scope: "cluster" | "namespace" | "service"
  generatedAt: string
  unitPrices: { cpuHourly: number; memGbHourly: number; storageGbHourly: number }
  items: Array<{
    id: string
    cpu: { cores: number; hourly: number }
    memory: { gb: number; hourly: number }
    storage: { gb: number; hourly: number }
    totalHourly: number
    totalMonthly: number
  }>
}

interface CostDetailResponse extends CostResponse["items"][number] {
  serviceId: string
  topPods: Array<{ pod: string; cpu: number; memGb: number; hourly: number }>
}

interface CostTrendResponse {
  scope: "cluster" | "namespace" | "service"
  id: string
  days: number
  points: Array<{ date: string; total: number }>
}
```

`days` 최대 90.

### 6.4 표준 응답 규약

- 200 정상 / 400 ValidationError / 401 Unauthorized / 403 Forbidden
- 503 `{ error: "Source unavailable", source: "prometheus" | "configmap", message }` (ConfigMap 미존재 + 캐시 미스)
- Prometheus timeout(5s): **200 + `items: []` + `notice` 필드** (graceful degradation)

### 6.5 신규 환경변수

```
COST_CPU_HOURLY=0.04
COST_MEM_GB_HOURLY=0.005
COST_STORAGE_GB_HOURLY=0.0001
SCORECARD_CONFIGMAP_NAME=narwhal-scorecard-rules
SCORECARD_CONFIGMAP_NAMESPACE=devtools
SERVICE_GRAPH_SOURCE=istio   # istio | hubble | both
```

---

## 7. Error Handling

| 외부 의존 | 실패 모드 | 포털 동작 |
|----------|----------|----------|
| Prometheus timeout | 5s | 200 + `items: []` + `notice` + 페이지 상단 노란 배너 |
| ConfigMap 미존재 | 404 | 503 `source: "configmap"` + "규칙 미정의" 안내 |
| Valkey 캐시 + Prometheus 양쪽 down | both | 503 + empty state |
| Istio sidecar 미주입 ns | 빈 결과 | 노드만 표시, "사이드카 미적용 워크로드는 의존성 미표시" hint |
| ArgoCD label 없는 워크로드 | unresolved | "Unmapped Pods" 별도 그룹 |

---

## 8. RBAC

| 라우트/UI | cluster-admin | developer | viewer | guest |
|-----------|---------------|-----------|--------|-------|
| 모든 신규 라우트 + 페이지 | ✓ | ✓ | ✓ | ✗ |

`nav.tsx` `menuItems[].roles`와 `tools.ts`는 동일하게 갱신. 게스트는 `/onboarding`, `/live`만 유지.

---

## 9. Testing

| 레이어 | 도구 | 범위 |
|--------|------|------|
| 단위 | Vitest | `scorecard.ts` 룰 9종 평가 엔진, `service-graph.ts` 노이즈 필터, `cost.ts` 단가 계산 |
| API 통합 | Vitest + msw | 라우트별 200/400/503 + Prometheus mock |
| E2E | Playwright | 3개 신규 화면 로드 + 행 클릭 → 상세 |
| 회귀 | portal-qa 에이전트 | API ↔ frontend type 일치, role gate, 캐시 키 충돌 |

핵심 케이스:
- Scorecard: 룰 9개 각각 pass/fail + 빈 ConfigMap + 잘못된 yaml + tier 경계값(89/90/91)
- Graph: self-call 제외, healthcheck 제외, low rate 제외, unmapped pods 처리, Hubble fallback
- Cost: kube_pod_labels 미조인 pod, PVC 없는 ns, 환경변수 미설정 시 $0 표시

---

## 10. Observability

신규 Prometheus 메트릭 (포털이 export):
- `narwhal_portal_scorecard_eval_duration_seconds` (히스토그램)
- `narwhal_portal_servicegraph_query_duration_seconds`
- `narwhal_portal_cost_query_duration_seconds`
- `narwhal_portal_source_unavailable_total{source}` (counter)

기존 `/api/metrics` 확장 또는 신규 scrape 엔드포인트. 클러스터 측 ServiceMonitor 추가 가이드는 운영 문서에.

---

## 11. Out of Scope / 후속 작업 후보

- Scorecard 룰 UI 편집 (현 PR 기반 유지)
- 멀티클러스터 비용/그래프 집계
- Kubecost/OpenCost 옵션 통합 (단가 정확도 향상 필요 시)
- Slack/Email로 점수 하락 알림
- 서비스 의존성 PR-time impact analysis ("이 PR이 영향 줄 서비스 N개")

---

## 12. 구현 순서 (writing-plans 입력용 힌트)

1. **Foundation:** `catalog.ts` 확장 + 신규 env + Prometheus recording rule(클러스터 측) + ConfigMap 정의
2. **Scorecard:** `scorecard.ts` evaluator + 3개 API + Quality 탭 + `/governance/scorecards`
3. **Service Graph:** `service-graph.ts` + 2개 API + Dependencies 탭 + `/architecture` Services 토글
4. **Cost:** `cost.ts` + 3개 API + Cost 탭 + `/cost` 페이지
5. **i18n + nav + tools 갱신 + 테스트 작성**
6. **QA (portal-qa) 회귀 + verifier 검증**

세 기능은 독립 구현 가능. 1번 foundation 후 2/3/4는 병렬 진행 가능.
