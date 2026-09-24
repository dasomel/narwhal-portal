/**
 * Cost Insights — Prometheus 사용량 × 환경변수 단가로 namespace/service 비용 추정
 *
 * spec §4.4: PromQL 기반 CPU/Memory/Storage 사용량 조회
 * spec §4.5: 캐시 TTL cost:{scope}:{id} = 5min, cost:trend:{scope}:{id}:{days} = 1hour
 */

import { cacheGet, cacheSet } from "./valkey"
import { namespaceVisible, type EffectiveScope } from "./scope"
import { getDependencyUrl, isProduction } from "./config"
// portal#64 AC3/AC4: reuse the telemetry vocabulary #51 (ClusterMetricsProjection)
// and 208c21d (scorecard unavailable-vs-fail) already established, instead of
// inventing a parallel one for cost responses.
import type { TelemetryStatus, EvidenceSource } from "./prometheus"

function prometheusUrl(): string {
  return getDependencyUrl("PROMETHEUS_URL", "http://localhost:9090")
}

export interface CostUnitPrices {
  cpuHourly: number
  memGbHourly: number
  storageGbHourly: number
}

export interface CostPricingMetadata {
  estimate: true
  currency: string
  version: string
  effectiveDate: string | null
  source: string
  scope: string | null
  configured: boolean
}

export interface CostPricing {
  unitPrices: CostUnitPrices
  metadata: CostPricingMetadata
}

export class CostPricingConfigurationError extends Error {
  constructor(public readonly invalid: string[]) {
    super(`Invalid production cost pricing configuration: ${invalid.join(", ")}`)
    this.name = "CostPricingConfigurationError"
  }
}

const DEVELOPMENT_PRICES: CostUnitPrices = {
  cpuHourly: 0.04,
  memGbHourly: 0.005,
  storageGbHourly: 0.0001,
}

const PRICE_ENV: Array<[keyof CostUnitPrices, string]> = [
  ["cpuHourly", "COST_CPU_HOURLY"],
  ["memGbHourly", "COST_MEM_GB_HOURLY"],
  ["storageGbHourly", "COST_STORAGE_GB_HOURLY"],
]

function configuredString(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function parsePrice(name: string): number | undefined {
  const value = configuredString(name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function isIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Reads cost pricing at request time. Production must never substitute the ADR's
 * development placeholder rates: callers receive an explicit configuration error
 * instead. Reading lazily also keeps Next's production build independent of env.
 */
export function getCostPricing(): CostPricing {
  const invalid: string[] = []
  const parsedPrices = {} as Partial<CostUnitPrices>
  for (const [key, env] of PRICE_ENV) {
    const price = parsePrice(env)
    if (price === undefined) invalid.push(env)
    else parsedPrices[key] = price
  }

  const currency = configuredString("COST_CURRENCY")
  if (!currency || !/^[A-Z]{3}$/.test(currency)) invalid.push("COST_CURRENCY")
  const version = configuredString("COST_PRICING_VERSION")
  if (!version) invalid.push("COST_PRICING_VERSION")
  const effectiveDate = configuredString("COST_PRICING_EFFECTIVE_DATE")
  if (!isIsoDate(effectiveDate)) invalid.push("COST_PRICING_EFFECTIVE_DATE")
  const source = configuredString("COST_PRICING_SOURCE")
  if (!source) invalid.push("COST_PRICING_SOURCE")
  const scope = configuredString("COST_PRICING_SCOPE")
  if (!scope) invalid.push("COST_PRICING_SCOPE")

  if (isProduction() && invalid.length > 0) {
    throw new CostPricingConfigurationError(invalid)
  }

  const configured = invalid.length === 0
  return {
    unitPrices: configured ? parsedPrices as CostUnitPrices : DEVELOPMENT_PRICES,
    metadata: {
      estimate: true,
      currency: currency ?? "USD",
      version: version ?? "development-placeholder",
      effectiveDate: effectiveDate ?? null,
      source: source ?? "development-placeholder",
      scope: scope ?? null,
      configured,
    },
  }
}

function pricingCacheKey(pricing: CostPricing): string {
  const { unitPrices, metadata } = pricing
  return encodeURIComponent([
    metadata.version,
    metadata.currency,
    metadata.effectiveDate ?? "",
    metadata.source,
    metadata.scope ?? "",
    unitPrices.cpuHourly,
    unitPrices.memGbHourly,
    unitPrices.storageGbHourly,
  ].join("|"))
}

// ---------------------------------------------------------------------------
// 타입 정의 (spec §4.4, §6.3)
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  scope: "cluster" | "namespace" | "service"
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number // hourly * 730 (ADR cost basis)
}

export interface CostItem {
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number
}

export interface TopPod {
  pod: string
  cpu: number
  memGb: number
  hourly: number
}

export interface CostDetailResult extends CostItem {
  serviceId: string
  topPods: TopPod[]
  telemetry: CostTelemetry
}

export interface CostTrendPoint {
  date: string  // YYYY-MM-DD
  total: number // 해당 날 일평균 hourly 비용
}

interface PromVectorResult {
  metric: Record<string, string>
  value: [number, string]
}

// ---------------------------------------------------------------------------
// Prometheus 헬퍼
// ---------------------------------------------------------------------------

const PROM_TIMEOUT_MS = 5000

async function queryVector(promql: string): Promise<PromVectorResult[]> {
  const url = `${prometheusUrl()}/api/v1/query?query=${encodeURIComponent(promql)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROM_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 0 } })
    if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`)
    const data = await res.json()
    return data?.data?.result ?? []
  } finally {
    clearTimeout(timer)
  }
}

async function queryRangeVector(
  promql: string,
  startTs: number,
  endTs: number,
  step: number
): Promise<Array<{ metric: Record<string, string>; values: [number, string][] }>> {
  const url = `${prometheusUrl()}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${startTs}&end=${endTs}&step=${step}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROM_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 0 } })
    if (!res.ok) throw new Error(`Prometheus range query failed: ${res.status}`)
    const data = await res.json()
    return data?.data?.result ?? []
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// PromQL 쿼리 빌더
// ---------------------------------------------------------------------------

// CPU cores: namespace 단위
function cpuByNamespaceQuery(): string {
  return `sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h]))`
}

// Memory bytes: namespace 단위
function memByNamespaceQuery(): string {
  return `sum by (namespace) (container_memory_working_set_bytes{container!="POD",container!=""})`
}

// Storage bytes: namespace 단위 (PVC 합산)
function storageByNamespaceQuery(): string {
  return `sum by (namespace) (kubelet_volume_stats_used_bytes)`
}

// CPU cores: service(label_app_kubernetes_io_instance) 단위
function cpuByServiceQuery(namespace?: string): string {
  const namespaceMatcher = namespace ? `,namespace="${namespace}"` : ""
  return `sum by (namespace, label_app_kubernetes_io_instance) (rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance!=""${namespaceMatcher}})`
}

// Memory bytes: service(label_app_kubernetes_io_instance) 단위
function memByServiceQuery(namespace?: string): string {
  const namespaceMatcher = namespace ? `,namespace="${namespace}"` : ""
  return `sum by (namespace, label_app_kubernetes_io_instance) (container_memory_working_set_bytes{container!="POD",container!=""} * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance!=""${namespaceMatcher}})`
}

// Top pods CPU: 특정 service의 pod별 사용량
function topPodCpuQuery(serviceId: string, namespace?: string): string {
  const namespaceMatcher = namespace ? `,namespace="${namespace}"` : ""
  return `sort_desc(sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${serviceId}"${namespaceMatcher}}))`
}

// Top pods Memory: 특정 service의 pod별 사용량
function topPodMemQuery(serviceId: string, namespace?: string): string {
  const namespaceMatcher = namespace ? `,namespace="${namespace}"` : ""
  return `sort_desc(sum by (namespace, pod) (container_memory_working_set_bytes{container!="POD",container!=""} * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${serviceId}"${namespaceMatcher}}))`
}

// 추이: 일별 avg_over_time — days일 치 24h 슬라이딩 윈도
//
// portal#61: cluster scope의 추이는 caller의 effective scope 밖 namespace까지
// 합산해 노출했다 — scopeNamespaceMatcher(effScope로 만든 regex alternation)를 넣으면
// cluster-admin이 아닌 caller가 볼 수 있는 namespace로만 합산을 제한한다.
// service scope는 route에서 이미 검증된 serviceNamespace로 직접 pin해 동일 라벨이
// 다른 team의 namespace에도 존재하는 경우의 교차 노출을 막는다 (getCostByService와
// 동일한 방어).
function scopeNamespaceMatcher(effScope: EffectiveScope): string {
  if (effScope.all) return ""
  const names = [...effScope.namespaces]
    .sort()
    .map((namespace) => namespace.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"))
  return `,namespace=~"^(?:${names.join("|") || "$^"})$"`
}

function trendCpuQuery(scope: string, id: string, effScope: EffectiveScope, serviceNamespace?: string): string {
  const namespaceMatcher = serviceNamespace ? `,namespace="${serviceNamespace}"` : scopeNamespaceMatcher(effScope)
  if (scope === "service") {
    return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!=""${namespaceMatcher}}[1h])[24h:1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${id}"})`
  }
  if (scope === "namespace") {
    return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!="",namespace="${id}"}[1h])[24h:1h]))`
  }
  // cluster
  return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!=""${namespaceMatcher}}[1h])[24h:1h]))`
}

function trendMemQuery(scope: string, id: string, effScope: EffectiveScope, serviceNamespace?: string): string {
  const namespaceMatcher = serviceNamespace ? `,namespace="${serviceNamespace}"` : scopeNamespaceMatcher(effScope)
  if (scope === "service") {
    return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!=""${namespaceMatcher}}[24h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${id}"})`
  }
  if (scope === "namespace") {
    return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!="",namespace="${id}"}[24h]))`
  }
  return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!=""${namespaceMatcher}}[24h]))`
}

// ---------------------------------------------------------------------------
// 비용 환산 헬퍼
// ---------------------------------------------------------------------------

function calcItem(id: string, cpuCores: number, memBytes: number, storageBytes: number, prices: CostUnitPrices): CostItem {
  const cpuHourly = cpuCores * prices.cpuHourly
  const memGb = memBytes / 1e9
  const memHourly = memGb * prices.memGbHourly
  const storageGb = storageBytes / 1e9
  const storageHourly = storageGb * prices.storageGbHourly
  const totalHourly = cpuHourly + memHourly + storageHourly
  return {
    id,
    cpu: { cores: Math.round(cpuCores * 1000) / 1000, hourly: Math.round(cpuHourly * 10000) / 10000 },
    memory: { gb: Math.round(memGb * 1000) / 1000, hourly: Math.round(memHourly * 10000) / 10000 },
    storage: { gb: Math.round(storageGb * 1000) / 1000, hourly: Math.round(storageHourly * 10000) / 10000 },
    totalHourly: Math.round(totalHourly * 10000) / 10000,
    totalMonthly: Math.round(totalHourly * 730 * 100) / 100,
  }
}

// ---------------------------------------------------------------------------
// Telemetry / exclusions 타입 정의 (portal#64 AC3/AC4)
//
// D1: state는 prometheus.ts의 TelemetryStatus를 그대로 재사용한다(#51
// ClusterMetricsProjection, 208c21d scorecard의 unavailable-vs-fail과 동일 어휘) —
// 이슈 문구의 "complete"라는 새 값을 만들지 않고 그 vocabulary의 "ok"를 그대로 쓴다.
// cost.ts는 K8s fallback이 없는 Prometheus 전용 소스라 source는 "prometheus" 또는
// "none"만 나온다.
// ---------------------------------------------------------------------------

export interface CostTelemetry {
  source: EvidenceSource
  queriedAt: string
  state: TelemetryStatus
  reason?: string
}

export interface UnlabeledWorkloadsExclusion {
  computable: boolean
  count: number | null
  cpu: number | null
  memoryGb: number | null
  hourly: number | null
}

// portal#64 크리틱 리뷰 #6: 이전에는 매 namespace CostItem에 storage와 완전히 동일한
// unallocatedStorage를 중복해서 붙였다 — 항상 storage와 같은 값이라 정보가 없고,
// storage 쿼리가 실패했을 때도 0으로 보여 "미할당 0원"과 "조회 실패"를 구분 못 했다.
// exclusions에 한 번만, 전체 namespace 합계로 노출하고 storage 쿼리 실패 시
// computable=false로 명시한다.
export interface UnallocatedStorageExclusion {
  computable: boolean
  gb: number | null
  hourly: number | null
}

export interface CostExclusions {
  unlabeledWorkloads?: UnlabeledWorkloadsExclusion
  storageExcludedFromServiceScope?: boolean
  unallocatedStorage?: UnallocatedStorageExclusion
}

export interface CostResult {
  items: CostItem[]
  notice?: string
  telemetry: CostTelemetry
  exclusions?: CostExclusions
}

export interface CostUnavailableResult {
  notice: string
  telemetry: CostTelemetry
}

export interface CostTrendResult {
  points: CostTrendPoint[]
  notice?: string
  telemetry: CostTelemetry
}

type QueryStatus = "ok" | "empty" | "unavailable"

// portal#64 Codex 리뷰 #1: settled.status==="fulfilled"만 보면 "쿼리는 성공했지만
// 벡터가 비어 있음"(스크레이프 갭일 수 있음)과 "정상적으로 값이 들어옴"을 구분하지
// 못해, 클러스터 전체가 empty vector인 스크레이프 아웃티지도 state="ok" + $0 아이템으로
// 보였다. prometheus.ts의 queryVectorExplicit(~L351)이 쓰는 것과 동일한 구분
// (seriesCount===0 → "empty")을 여기서도 재사용한다.
function vectorStatus(settled: PromiseSettledResult<PromVectorResult[]>): QueryStatus {
  if (settled.status === "rejected") return "unavailable"
  return settled.value.length === 0 ? "empty" : "ok"
}

// range 쿼리는 series 자체가 없거나(빈 배열) series는 있지만 그 안의 values가 비어
// 있을 수 있다 — 두 경우 모두 "이 기간에 대한 실측치가 없다"는 점에서 "empty"로 취급.
function rangeStatus(
  settled: PromiseSettledResult<Array<{ metric: Record<string, string>; values: [number, string][] }>>
): QueryStatus {
  if (settled.status === "rejected") return "unavailable"
  // series.values is defensively optional-chained: a malformed/mocked response
  // shaped like an instant-vector result (no `values` array) must not throw here.
  return settled.value.some((series) => (series.values?.length ?? 0) > 0) ? "ok" : "empty"
}

function rejectReasons(settled: PromiseSettledResult<unknown>[]): string[] {
  return settled
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
}

// portal#64 AC4: 여러 PromQL 쿼리 중 일부만 실패해도 이전에는 Promise.all이 첫 실패에서
// 즉시 reject해 "완전 실패"와 "일부 실패"를 구분하지 못했다. #51 getClusterMetrics의
// okCount 패턴(okCount===N?"ok":okCount>0?"partial":"unavailable")을 재사용하되,
// "ok"는 실제 값이 있는 경우만 세고(크리틱 #1), 전부 fulfilled인데 전부 비어 있으면
// "unavailable"이 아니라 prometheus.ts와 같은 어휘인 "empty"로 구분한다 — 호출부가
// 이를 unavailable과 동일하게 취급(캐시 안 함, $0 아이템 대신 items:[])할지는 각
// 함수가 스코프별로 결정한다.
function combineTelemetry(statuses: QueryStatus[], queriedAt: string, reasons: string[] = []): CostTelemetry {
  const okCount = statuses.filter((s) => s === "ok").length
  const unavailableCount = statuses.filter((s) => s === "unavailable").length
  let state: TelemetryStatus
  if (okCount === statuses.length) {
    state = "ok"
  } else if (okCount > 0) {
    state = "partial"
  } else if (unavailableCount === statuses.length) {
    state = "unavailable" // 전부 실패 — 진짜 장애.
  } else if (unavailableCount === 0) {
    state = "empty" // 전부 fulfilled인데 전부 empty — 응답은 왔지만 값이 없다.
  } else {
    state = "partial" // empty/unavailable 혼재, ok는 하나도 없음 — 신뢰 가능한 값 없음.
  }
  return {
    source: unavailableCount === statuses.length ? "none" : "prometheus",
    queriedAt,
    state,
    ...(reasons.length > 0 ? { reason: [...new Set(reasons)].join("; ") } : {}),
  }
}

// 기존 AbortError 타임아웃 메시지를 그대로 보존한다 — Promise.allSettled로 바뀌면서
// 개별 reject의 예외 인스턴스를 다시 catch하는 대신 reject 이유들을 훑어 판단한다.
function timeoutNotice(settled: PromiseSettledResult<unknown>[]): string {
  const timedOut = settled.some(
    (r) => r.status === "rejected" && r.reason instanceof Error && r.reason.name === "AbortError"
  )
  return timedOut
    ? "Prometheus 응답 시간 초과(5s). 잠시 후 다시 시도하세요."
    : "Prometheus 쿼리 실패. 메트릭 수집 서버 상태를 확인하세요."
}

// portal#64 Codex 리뷰 #1: 쿼리는 전부 성공했지만 값이 전혀 없을 때(state="empty")
// 쓰는 notice — timeoutNotice의 실패 문구를 재사용하면 실제로는 실패가 아닌데
// "쿼리 실패/타임아웃"이라고 잘못 알리게 된다.
const EMPTY_NOTICE = "Prometheus 쿼리는 성공했지만 반환된 데이터가 없습니다. 스크레이프 상태를 확인하세요."

// label_app_kubernetes_io_instance가 없는(또는 "unknown"인 — 아래 getCost 참고)
// workload(pod) 개수를 namespace별로 반환한다. 이전 버전은 count(...)로 전체를
// 스칼라 하나로 뭉개 caller의 effScope와 무관하게 다른 team의 namespace까지 센
// pod 수를 노출했다 — count by (namespace)로 바꿔 getCost의 다른 쿼리들과 동일하게
// JS에서 namespaceVisible로 필터링한 뒤 합산한다 (portal#64 크리틱 리뷰 #2).
// kube_pod_labels 쪽 matcher에 "unknown"도 빼서, 코드에서 svc==="unknown"을
// unlabeled로 취급하는 것과 일관되게 만든다 (크리틱 리뷰 #3).
function unlabeledWorkloadCountQuery(): string {
  return `count by (namespace) (count by (pod, namespace) (container_cpu_usage_seconds_total{container!="POD",container!=""}) unless on(pod, namespace) count by (pod, namespace) (kube_pod_labels{label_app_kubernetes_io_instance!="",label_app_kubernetes_io_instance!="unknown"}))`
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * getCost: scope별 비용 목록 반환
 * - cluster: 클러스터 전체 합산 1개 항목
 * - namespace: namespace별 항목 목록
 * - service: service(label_app_kubernetes_io_instance)별 항목 목록
 *
 * portal#28: 반환하는 모든 항목(단일 cluster 합산 포함)은 effScope로 가시성 필터링된
 * PromQL 행에서만 계산한다 — developer/viewer가 다른 팀의 namespace/service 비용을,
 * 심지어 "cluster" 합산을 통해서도 간접적으로 보지 못하게 한다. cluster-admin은
 * namespaceVisible이 항상 true라 기존과 동일하게 전체를 본다. 캐시 키에 effScope의
 * fingerprint를 넣어 서로 다른 스코프의 결과가 캐시에서 충돌하지 않게 한다
 * (governance/scorecard, governance/dora와 같은 패턴).
 *
 * portal#64 AC4: 쿼리 중 일부만 실패해도 이전에는 Promise.all이 즉시 reject해
 * "완전 실패"로 뭉개졌다 — Promise.allSettled로 바꿔 실제 성공/실패 개수를
 * telemetry.state(ok/partial/unavailable)로 노출한다. unavailable일 때는 기존과
 * 동일하게 캐시하지 않는다(빈 items를 TTL 동안 재사용하면 Prometheus가 복구된 뒤에도
 * 계속 unavailable을 반환하게 된다). partial도 마찬가지로 캐시하지 않는다 — degraded
 * 값을 5분/1시간 TTL 동안 재사용하면 Prometheus가 바로 복구돼도 계속 저평가된 비용을
 * 보여주게 된다(크리틱 리뷰 #1); state==="ok"일 때만 캐시한다.
 */
export async function getCost(
  scope: "cluster" | "namespace" | "service",
  effScope: EffectiveScope
): Promise<CostResult> {
  const pricing = getCostPricing()
  const { unitPrices } = pricing
  // v2: 캐시에 telemetry/exclusions가 없던 이전 배포분의 항목을 그대로 반환하지
  // 않도록 키 네임스페이스를 분리한다 (크리틱 리뷰 #7).
  const cacheKey = `cost:v2:${scope}:${effScope.fingerprint}:${pricingCacheKey(pricing)}`
  const cached = await cacheGet<CostResult>(cacheKey)
  if (cached !== null) return cached

  const queriedAt = new Date().toISOString()

  if (scope === "cluster") {
    const settled = await Promise.allSettled([
      queryVector(cpuByNamespaceQuery()),
      queryVector(memByNamespaceQuery()),
      queryVector(storageByNamespaceQuery()),
    ])
    const telemetry = combineTelemetry(settled.map(vectorStatus), queriedAt, rejectReasons(settled))
    // Codex 리뷰 #1: 전부 empty(스크레이프 아웃티지일 수 있음)도 unavailable과
    // 동일하게 취급 — 그렇지 않으면 $0 cluster 아이템이 "실측된 0원"처럼 보이고
    // 300초 캐시에 그대로 남는다.
    if (telemetry.state === "unavailable" || telemetry.state === "empty") {
      const notice = telemetry.state === "empty" ? EMPTY_NOTICE : timeoutNotice(settled)
      return { items: [], notice, telemetry }
    }
    const cpuRes = settled[0].status === "fulfilled" ? settled[0].value : []
    const memRes = settled[1].status === "fulfilled" ? settled[1].value : []
    const storRes = settled[2].status === "fulfilled" ? settled[2].value : []
    const visible = (r: PromVectorResult) => namespaceVisible(r.metric.namespace ?? "", effScope)
    const cpuTotal = cpuRes.filter(visible).reduce((s, r) => s + parseFloat(r.value[1]), 0)
    const memTotal = memRes.filter(visible).reduce((s, r) => s + parseFloat(r.value[1]), 0)
    const storTotal = storRes.filter(visible).reduce((s, r) => s + parseFloat(r.value[1]), 0)
    const items = [calcItem("cluster", cpuTotal, memTotal, storTotal, unitPrices)]
    const result: CostResult = { items, telemetry }
    if (telemetry.state === "ok") await cacheSet(cacheKey, result, 300) // 5min
    return result
  }

  if (scope === "namespace") {
    const settled = await Promise.allSettled([
      queryVector(cpuByNamespaceQuery()),
      queryVector(memByNamespaceQuery()),
      queryVector(storageByNamespaceQuery()),
    ])
    const telemetry = combineTelemetry(settled.map(vectorStatus), queriedAt, rejectReasons(settled))
    if (telemetry.state === "unavailable" || telemetry.state === "empty") {
      const notice = telemetry.state === "empty" ? EMPTY_NOTICE : timeoutNotice(settled)
      return { items: [], notice, telemetry }
    }
    const cpuRes = settled[0].status === "fulfilled" ? settled[0].value : []
    const memRes = settled[1].status === "fulfilled" ? settled[1].value : []
    const storSettled = settled[2]
    const storRes = storSettled.status === "fulfilled" ? storSettled.value : []
    // namespace 맵 구성
    const cpuMap = new Map<string, number>()
    const memMap = new Map<string, number>()
    const storMap = new Map<string, number>()
    for (const r of cpuRes) {
      const ns = r.metric.namespace
      if (ns && ns !== "unknown" && namespaceVisible(ns, effScope)) cpuMap.set(ns, parseFloat(r.value[1]))
    }
    for (const r of memRes) {
      const ns = r.metric.namespace
      if (ns && ns !== "unknown" && namespaceVisible(ns, effScope)) memMap.set(ns, (memMap.get(ns) ?? 0) + parseFloat(r.value[1]))
    }
    for (const r of storRes) {
      const ns = r.metric.namespace
      if (ns && ns !== "unknown" && namespaceVisible(ns, effScope)) storMap.set(ns, (storMap.get(ns) ?? 0) + parseFloat(r.value[1]))
    }
    // Storage-only namespaces still represent billable resources. Excluding
    // storMap here silently hides PVC cost when no CPU/memory sample exists.
    const namespaces = new Set([...cpuMap.keys(), ...memMap.keys(), ...storMap.keys()])
    const items: CostItem[] = []
    for (const ns of namespaces) {
      items.push(calcItem(ns, cpuMap.get(ns) ?? 0, memMap.get(ns) ?? 0, storMap.get(ns) ?? 0, unitPrices))
    }
    items.sort((a, b) => b.totalHourly - a.totalHourly)

    // portal#64 AC3 (크리틱 리뷰 #6): namespace scope는 storage를 어떤 service에도
    // 배분하지 않는다 (service scope는 storage를 항상 0으로 처리 — 아래 참고) — 이
    // storage 합계 전액이 미할당 상태임을 exclusions에 한 번만 구조화해서 노출한다.
    // storage 쿼리 자체가 실패했으면(partial) 0이 아니라 computable=false로 표시한다.
    const unallocatedStorage: UnallocatedStorageExclusion =
      storSettled.status === "fulfilled"
        ? {
            computable: true,
            gb: Math.round(items.reduce((s, i) => s + i.storage.gb, 0) * 1000) / 1000,
            hourly: Math.round(items.reduce((s, i) => s + i.storage.hourly, 0) * 10000) / 10000,
          }
        : { computable: false, gb: null, hourly: null }

    const result: CostResult = { items, telemetry, exclusions: { unallocatedStorage } }
    if (telemetry.state === "ok") await cacheSet(cacheKey, result, 300)
    return result
  }

  // scope === "service"
  const settled = await Promise.allSettled([
    queryVector(cpuByServiceQuery()),
    queryVector(memByServiceQuery()),
    queryVector(cpuByNamespaceQuery()),
    queryVector(memByNamespaceQuery()),
    queryVector(unlabeledWorkloadCountQuery()),
  ])
  const [cpuSettled, memSettled, totalCpuSettled, totalMemSettled, countSettled] = settled
  // portal#64 AC4: telemetry.state는 items 계산에 실제로 쓰이는 앞의 두 쿼리(cpu/mem
  // by service)만 반영한다 — 나머지 3개는 exclusions 계산 전용 보조 쿼리라 그 실패는
  // exclusions.unlabeledWorkloads.computable=false로만 나타나야 하고, 정상 계산된
  // items를 "partial"로 오염시키면 안 된다. (service scope의 "전부 empty"는 라벨이
  // 아예 없는 정상 상태일 수 있어 cluster/namespace와 달리 조기 반환하지 않는다 —
  // 아래 items.length===0 분기가 이미 그 의미 있는 notice/exclusions를 만든다.)
  const telemetry = combineTelemetry(
    [vectorStatus(cpuSettled), vectorStatus(memSettled)],
    queriedAt,
    rejectReasons([cpuSettled, memSettled])
  )
  if (telemetry.state === "unavailable") {
    return { items: [], notice: timeoutNotice([cpuSettled, memSettled]), telemetry }
  }
  const nsVisible = (ns: string | undefined) => !!ns && namespaceVisible(ns, effScope)
  // labeled(단, "unknown"은 미분류로 취급 — unlabeledWorkloadCountQuery의
  // label_app_kubernetes_io_instance!="unknown"과 동일 기준, 크리틱 리뷰 #3)한 pod의
  // cpu/mem을 service별(cpuMap/memMap, items 계산용)과 namespace별
  // (labeledCpuByNs/labeledMemByNs, 아래 unlabeled 근사용) 양쪽으로 동시에 누적한다.
  // 이전 버전은 cpuMap을 set()으로 덮어써 같은 service 이름이 여러 namespace에
  // 걸쳐 있으면 cpu가 과소집계됐다 — mem과 동일하게 누적(+=)으로 고친다.
  const cpuRes = cpuSettled.status === "fulfilled" ? cpuSettled.value : []
  const memRes = memSettled.status === "fulfilled" ? memSettled.value : []
  const cpuMap = new Map<string, number>()
  const memMap = new Map<string, number>()
  const labeledCpuByNs = new Map<string, number>()
  const labeledMemByNs = new Map<string, number>()
  for (const r of cpuRes) {
    const svc = r.metric.label_app_kubernetes_io_instance
    const ns = r.metric.namespace
    if (!svc || svc === "unknown" || svc === "" || !nsVisible(ns)) continue
    const val = parseFloat(r.value[1])
    cpuMap.set(svc, (cpuMap.get(svc) ?? 0) + val)
    labeledCpuByNs.set(ns as string, (labeledCpuByNs.get(ns as string) ?? 0) + val)
  }
  for (const r of memRes) {
    const svc = r.metric.label_app_kubernetes_io_instance
    const ns = r.metric.namespace
    if (!svc || svc === "unknown" || svc === "" || !nsVisible(ns)) continue
    const val = parseFloat(r.value[1])
    memMap.set(svc, (memMap.get(svc) ?? 0) + val)
    labeledMemByNs.set(ns as string, (labeledMemByNs.get(ns as string) ?? 0) + val)
  }
  const services = new Set([...cpuMap.keys(), ...memMap.keys()])
  const items: CostItem[] = []
  for (const svc of services) {
    // service scope: storage는 PVC를 service에 매핑하기 어려우므로 0으로 처리
    items.push(calcItem(svc, cpuMap.get(svc) ?? 0, memMap.get(svc) ?? 0, 0, unitPrices))
  }

  // portal#64 AC3: unlabeled workload 비용을 namespace별 "전체 - labeled"로 근사한
  // 뒤 합산한다. 하나의 grand total로 뺀 뒤 한 번만 클램프하면, 어떤 namespace의
  // 음수 오차(서로 다른 origin의 PromQL 간 부동소수점/타이밍 차이)가 다른
  // namespace의 진짜 unlabeled 값을 상쇄해버릴 수 있어 namespace 단위로 먼저
  // Math.max(0, ...)한 뒤 더한다 (크리틱 리뷰 #3). 5개 쿼리 중 하나라도 실패하면
  // 왜곡된 값을 보여줄 수 있어 computable=false로 전부 null 처리한다.
  let unlabeledWorkloads: UnlabeledWorkloadsExclusion
  if (
    cpuSettled.status === "fulfilled" &&
    memSettled.status === "fulfilled" &&
    totalCpuSettled.status === "fulfilled" &&
    totalMemSettled.status === "fulfilled" &&
    countSettled.status === "fulfilled"
  ) {
    const totalCpuByNs = new Map<string, number>()
    for (const r of totalCpuSettled.value) {
      const ns = r.metric.namespace
      if (nsVisible(ns)) totalCpuByNs.set(ns as string, (totalCpuByNs.get(ns as string) ?? 0) + parseFloat(r.value[1]))
    }
    const totalMemByNs = new Map<string, number>()
    for (const r of totalMemSettled.value) {
      const ns = r.metric.namespace
      if (nsVisible(ns)) totalMemByNs.set(ns as string, (totalMemByNs.get(ns as string) ?? 0) + parseFloat(r.value[1]))
    }
    const allNamespaces = new Set([
      ...totalCpuByNs.keys(),
      ...totalMemByNs.keys(),
      ...labeledCpuByNs.keys(),
      ...labeledMemByNs.keys(),
    ])
    let unlabeledCpu = 0
    let unlabeledMemBytes = 0
    for (const ns of allNamespaces) {
      unlabeledCpu += Math.max(0, (totalCpuByNs.get(ns) ?? 0) - (labeledCpuByNs.get(ns) ?? 0))
      unlabeledMemBytes += Math.max(0, (totalMemByNs.get(ns) ?? 0) - (labeledMemByNs.get(ns) ?? 0))
    }
    const unlabeledMemGb = unlabeledMemBytes / 1e9
    const unlabeledHourly = unlabeledCpu * unitPrices.cpuHourly + unlabeledMemGb * unitPrices.memGbHourly
    // unlabeledWorkloadCountQuery는 이제 count by (namespace) — 다른 쿼리들과 동일하게
    // effScope로 가시성 필터링한 뒤 합산한다 (크리틱 리뷰 #2: 이전에는 caller의 scope와
    // 무관하게 전체 카운트를 스칼라 하나로 노출했다).
    const count = countSettled.value
      .filter((r) => nsVisible(r.metric.namespace))
      .reduce((s, r) => s + parseFloat(r.value[1]), 0)
    unlabeledWorkloads = {
      computable: true,
      count: Math.round(count),
      cpu: Math.round(unlabeledCpu * 1000) / 1000,
      memoryGb: Math.round(unlabeledMemGb * 1000) / 1000,
      hourly: Math.round(unlabeledHourly * 10000) / 10000,
    }
  } else {
    unlabeledWorkloads = { computable: false, count: null, cpu: null, memoryGb: null, hourly: null }
  }
  const exclusions: CostExclusions = {
    unlabeledWorkloads,
    storageExcludedFromServiceScope: true,
  }
  // Codex 리뷰 #4: telemetry.state==="ok"는 core(cpu/mem-by-service) 쿼리만 보므로
  // 보조(exclusions) 쿼리가 실패해도 여기까지는 "ok"로 도달한다 — computable=false로
  // degraded된 exclusions를 그대로 5분 캐시하면 아래 UI가 그 동안 계속 "집계 불가"를
  // 실제 값처럼 보여준다(또는 조용히 숨긴다). computable할 때만 캐시해 다음 호출이
  // 재조회하도록 한다.
  const exclusionsComputable = unlabeledWorkloads.computable

  if (items.length === 0) {
    const result: CostResult = {
      items: [],
      notice: "label_app_kubernetes_io_instance 라벨이 없는 워크로드는 표시되지 않습니다. kube_pod_labels 메트릭 수집 여부를 확인하세요.",
      telemetry,
      exclusions,
    }
    if (telemetry.state === "ok" && exclusionsComputable) await cacheSet(cacheKey, result, 300)
    return result
  }
  items.sort((a, b) => b.totalHourly - a.totalHourly)
  const result: CostResult = {
    items,
    notice: "서비스별 비용에는 PVC/storage가 포함되지 않습니다. namespace 비용에서 미할당 storage를 확인하세요.",
    telemetry,
    exclusions,
  }
  if (telemetry.state === "ok" && exclusionsComputable) await cacheSet(cacheKey, result, 300)
  return result
}

/**
 * getCostByService: 단일 service 비용 + top 5 pods
 *
 * portal#61: 호출자의 scope 안에 있는 service인지, 그리고 그 service가 실제로 속한
 * namespace가 무엇인지는 route 레벨에서 getArgoApp + appVisible로 이미 검증됐다는
 * 전제. serviceNamespace를 PromQL 쿼리 자체에 pin하고 결과를 다시 namespace로
 * 필터링해 동일 label_app_kubernetes_io_instance 값이 다른 team의 namespace에도
 * 존재하는 경우의 교차 노출을 막는다. 캐시 키에 effScope.fingerprint +
 * serviceNamespace를 포함하는 이유도 동일 — resolved scope나 namespace 매핑이
 * 바뀌면 이전 caller의 캐시를 재사용하면 안 된다.
 */
export async function getCostByService(
  serviceId: string,
  effScope: EffectiveScope,
  serviceNamespace: string
): Promise<CostDetailResult | CostUnavailableResult> {
  const pricing = getCostPricing()
  const { unitPrices } = pricing
  // v2: see getCost's cache key comment (크리틱 리뷰 #7).
  const cacheKey = `cost:service:v2:${effScope.fingerprint}:${serviceNamespace}:${serviceId}:${pricingCacheKey(pricing)}`
  const cached = await cacheGet<CostDetailResult | CostUnavailableResult>(cacheKey)
  if (cached !== null) return cached

  const queriedAt = new Date().toISOString()
  const settled = await Promise.allSettled([
    queryVector(cpuByServiceQuery(serviceNamespace)),
    queryVector(memByServiceQuery(serviceNamespace)),
    queryVector(topPodCpuQuery(serviceId, serviceNamespace)),
    queryVector(topPodMemQuery(serviceId, serviceNamespace)),
  ])
  const telemetry = combineTelemetry(settled.map(vectorStatus), queriedAt, rejectReasons(settled))
  if (telemetry.state === "unavailable") {
    return { notice: timeoutNotice(settled), telemetry }
  }
  const [cpuSettled, memSettled, topCpuSettled, topMemSettled] = settled
  const cpuRes = cpuSettled.status === "fulfilled" ? cpuSettled.value : []
  const memRes = memSettled.status === "fulfilled" ? memSettled.value : []
  const topCpuRes = topCpuSettled.status === "fulfilled" ? topCpuSettled.value : []
  const topMemRes = topMemSettled.status === "fulfilled" ? topMemSettled.value : []

  // 해당 service 항목 추출
  // D1: Trust the route's app/project authorization here; PromQL is already pinned
  // to that app's namespace. Re-checking only namespace mappings hides project-only
  // access. If another caller needs this helper, pass an explicit predicate instead.
  const matchesService = (r: PromVectorResult) =>
    r.metric.label_app_kubernetes_io_instance === serviceId &&
    r.metric.namespace === serviceNamespace
  const cpuCores = cpuRes.filter(matchesService).reduce((sum, r) => sum + parseFloat(r.value[1]), 0)
  const memBytes = memRes.filter(matchesService).reduce((sum, r) => sum + parseFloat(r.value[1]), 0)

  const base = calcItem(serviceId, cpuCores, memBytes, 0, unitPrices)

  // top pods 구성 (pod별 cpu + mem, top 5)
  const podCpuMap = new Map<string, number>()
  const podMemMap = new Map<string, number>()
  for (const r of topCpuRes.slice(0, 10)) {
    const pod = r.metric.pod
    if (pod && r.metric.namespace === serviceNamespace) {
      podCpuMap.set(`${r.metric.namespace}/${pod}`, parseFloat(r.value[1]))
    }
  }
  for (const r of topMemRes.slice(0, 10)) {
    const pod = r.metric.pod
    if (pod && r.metric.namespace === serviceNamespace) {
      podMemMap.set(`${r.metric.namespace}/${pod}`, parseFloat(r.value[1]))
    }
  }
  const allPods = new Set([...podCpuMap.keys(), ...podMemMap.keys()])
  const topPods: TopPod[] = []
  for (const pod of allPods) {
    const podCpu = podCpuMap.get(pod) ?? 0
    const podMemGb = (podMemMap.get(pod) ?? 0) / 1e9
    const podHourly =
      podCpu * unitPrices.cpuHourly + podMemGb * unitPrices.memGbHourly
    topPods.push({
      pod,
      cpu: Math.round(podCpu * 1000) / 1000,
      memGb: Math.round(podMemGb * 1000) / 1000,
      hourly: Math.round(podHourly * 10000) / 10000,
    })
  }
  topPods.sort((a, b) => b.hourly - a.hourly)

  const result: CostDetailResult = {
    ...base,
    serviceId,
    topPods: topPods.slice(0, 5),
    telemetry,
  }
  // 크리틱 리뷰 #1: partial(예: topPods 쿼리는 실패, cpu/mem은 성공)도 unavailable과
  // 마찬가지로 캐시하지 않는다 — state==="ok"일 때만 5분 TTL로 캐시한다.
  if (telemetry.state === "ok") await cacheSet(cacheKey, result, 300)
  return result
}

/**
 * getCostTrend: 일별 비용 추이 (days일, 최대 90)
 * spec §4.4: avg_over_time(...[24h]) 슬라이딩 윈도, 30일 30 데이터포인트
 */
export async function getCostTrend(
  scope: "cluster" | "namespace" | "service",
  id: string,
  days: number,
  effScope: EffectiveScope,
  serviceNamespace?: string
): Promise<CostTrendResult> {
  const pricing = getCostPricing()
  const { unitPrices } = pricing
  const safeDays = Math.min(days, 90)
  // portal#61: namespace/service scope는 route에서 이미 visibility 검증된 id(+
  // service scope의 경우 resolved serviceNamespace)만 넘어오지만, cluster scope의
  // 집계는 caller마다 볼 수 있는 namespace가 달라 cache key에 fingerprint가
  // 반드시 필요하다 (getCost/getCostByService의 동일 이유). serviceNamespace를
  // 키에 포함해 동일 service id가 다른 namespace로 재매핑되는 경우도 캐시가
  // 갈린다. pricingCacheKey는 모든 scope에 필요 — 단가 설정이 바뀌면 과거 응답을
  // 재사용하면 안 된다.
  // v2: see getCost's cache key comment (크리틱 리뷰 #7).
  const cacheKey = `cost:trend:v2:${scope}:${effScope.fingerprint}:${serviceNamespace ?? ""}:${id}:${safeDays}:${pricingCacheKey(pricing)}`
  const cached = await cacheGet<CostTrendResult>(cacheKey)
  if (cached !== null) return cached

  const queriedAt = new Date().toISOString()

  // cluster scope: cluster-admin(all)이 아니면 caller가 볼 수 있는 namespace로만
  // 합산을 제한한다. 볼 수 있는 namespace가 없으면 Prometheus를 호출할 필요 없이
  // 빈 결과를 반환한다. (실제 필터링은 trendCpuQuery/trendMemQuery 내부의
  // scopeNamespaceMatcher(effScope)가 수행한다.) 이 경로는 쿼리를 아예 보내지 않는
  // 진짜 "empty"라 unavailable(실패)과 구분하기 위해 telemetry.state="empty"를 쓴다
  // (portal#64 AC4) — combineTelemetry가 만드는 ok/partial/unavailable과는 다른,
  // TelemetryStatus의 별도 값.
  if (scope === "cluster" && !effScope.all && effScope.namespaces.size === 0) {
    const empty: CostTrendResult = {
      points: [],
      telemetry: { source: "none", queriedAt, state: "empty" },
    }
    await cacheSet(cacheKey, empty, 3600)
    return empty
  }

  const end = Math.floor(Date.now() / 1000)
  const start = end - safeDays * 86400
  const step = 86400 // 1일 step

  const settled = await Promise.allSettled([
    queryRangeVector(trendCpuQuery(scope, id, effScope, serviceNamespace), start, end, step),
    queryRangeVector(trendMemQuery(scope, id, effScope, serviceNamespace), start, end, step),
  ])
  const telemetry = combineTelemetry(settled.map(rangeStatus), queriedAt, rejectReasons(settled))
  if (telemetry.state === "unavailable") {
    return { points: [], notice: timeoutNotice(settled), telemetry }
  }
  const [cpuSettled, memSettled] = settled
  const cpuRange = cpuSettled.status === "fulfilled" ? cpuSettled.value : []
  const memRange = memSettled.status === "fulfilled" ? memSettled.value : []

  // 첫 번째 series의 values 사용 (sum이라 시리즈 하나)
  const cpuValues = cpuRange[0]?.values ?? []
  const memValues = memRange[0]?.values ?? []

  // Codex 리뷰 #2: 이전에는 points를 cpuValues 하나로만 map해서, cpu 쿼리가
  // 실패(또는 결과가 비어)했으면 mem이 성공했어도 points 전체가 []가 됐다 — telemetry
  // 는 partial인데 차트는 완전히 비어 보이는 모순. 두 시리즈 timestamp의 합집합을
  // 기준으로 points를 만들고, 한쪽이 없는 timestamp는 그 component 기여를 0으로
  // 처리한다(다른 쪽 데이터라도 보여주는 편이 points를 통째로 지우는 것보다 낫다 —
  // telemetry.state가 이미 partial/empty로 저평가 가능성을 알린다).
  const cpuByTs = new Map<number, number>()
  for (const [ts, val] of cpuValues) cpuByTs.set(ts, parseFloat(val))
  const memByTs = new Map<number, number>()
  for (const [ts, val] of memValues) memByTs.set(ts, parseFloat(val))
  const allTimestamps = [...new Set([...cpuByTs.keys(), ...memByTs.keys()])].sort((a, b) => a - b)

  const points: CostTrendPoint[] = allTimestamps.map((ts) => {
    const cpuCores = cpuByTs.get(ts) ?? 0
    const memBytes = memByTs.get(ts) ?? 0
    const totalHourly =
      cpuCores * unitPrices.cpuHourly + (memBytes / 1e9) * unitPrices.memGbHourly
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    return { date, total: Math.round(totalHourly * 10000) / 10000 }
  })

  const result: CostTrendResult = { points, telemetry }
  // 크리틱 리뷰 #1: partial도 캐시하지 않는다 — state==="ok"일 때만 1시간 TTL로 캐시.
  if (telemetry.state === "ok") await cacheSet(cacheKey, result, 3600) // 1hour
  return result
}
