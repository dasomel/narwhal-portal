/**
 * Cost Insights — Prometheus 사용량 × 환경변수 단가로 namespace/service 비용 추정
 *
 * spec §4.4: PromQL 기반 CPU/Memory/Storage 사용량 조회
 * spec §4.5: 캐시 TTL cost:{scope}:{id} = 5min, cost:trend:{scope}:{id}:{days} = 1hour
 */

import { cacheGet, cacheSet } from "./valkey"

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090"

// 단가: 모듈 로드 시 env 읽고 number 변환 (default: spec §4.4 기본값)
const UNIT_PRICES = {
  cpuHourly: parseFloat(process.env.COST_CPU_HOURLY ?? "0.04"),
  memGbHourly: parseFloat(process.env.COST_MEM_GB_HOURLY ?? "0.005"),
  storageGbHourly: parseFloat(process.env.COST_STORAGE_GB_HOURLY ?? "0.0001"),
} as const

// NaN guard: env에 잘못된 값이 설정되면 default로 fallback
const PRICES = {
  cpuHourly: isNaN(UNIT_PRICES.cpuHourly) ? 0.04 : UNIT_PRICES.cpuHourly,
  memGbHourly: isNaN(UNIT_PRICES.memGbHourly) ? 0.005 : UNIT_PRICES.memGbHourly,
  storageGbHourly: isNaN(UNIT_PRICES.storageGbHourly) ? 0.0001 : UNIT_PRICES.storageGbHourly,
}

export { PRICES as unitPrices }

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
  totalMonthly: number // hourly * 720
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
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`
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
  const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${startTs}&end=${endTs}&step=${step}`
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
function cpuByServiceQuery(): string {
  return `sum by (namespace, label_app_kubernetes_io_instance) (rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels)`
}

// Memory bytes: service(label_app_kubernetes_io_instance) 단위
function memByServiceQuery(): string {
  return `sum by (namespace, label_app_kubernetes_io_instance) (container_memory_working_set_bytes{container!="POD",container!=""} * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels)`
}

// Top pods CPU: 특정 service의 pod별 사용량
function topPodCpuQuery(serviceId: string): string {
  return `sort_desc(sum by (pod) (rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${serviceId}"}))`
}

// Top pods Memory: 특정 service의 pod별 사용량
function topPodMemQuery(serviceId: string): string {
  return `sort_desc(sum by (pod) (container_memory_working_set_bytes{container!="POD",container!=""} * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${serviceId}"}))`
}

// 추이: 일별 avg_over_time — days일 치 24h 슬라이딩 윈도
function trendCpuQuery(scope: string, id: string): string {
  if (scope === "service") {
    return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h])[24h:1h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${id}"})`
  }
  if (scope === "namespace") {
    return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!="",namespace="${id}"}[1h])[24h:1h]))`
  }
  // cluster
  return `sum(avg_over_time(rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[1h])[24h:1h]))`
}

function trendMemQuery(scope: string, id: string): string {
  if (scope === "service") {
    return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!=""}[24h]) * on(pod, namespace) group_left(label_app_kubernetes_io_instance) kube_pod_labels{label_app_kubernetes_io_instance="${id}"})`
  }
  if (scope === "namespace") {
    return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!="",namespace="${id}"}[24h]))`
  }
  return `sum(avg_over_time(container_memory_working_set_bytes{container!="POD",container!=""}[24h]))`
}

// ---------------------------------------------------------------------------
// 비용 환산 헬퍼
// ---------------------------------------------------------------------------

function calcItem(id: string, cpuCores: number, memBytes: number, storageBytes: number): CostItem {
  const cpuHourly = cpuCores * PRICES.cpuHourly
  const memGb = memBytes / 1e9
  const memHourly = memGb * PRICES.memGbHourly
  const storageGb = storageBytes / 1e9
  const storageHourly = storageGb * PRICES.storageGbHourly
  const totalHourly = cpuHourly + memHourly + storageHourly
  return {
    id,
    cpu: { cores: Math.round(cpuCores * 1000) / 1000, hourly: Math.round(cpuHourly * 10000) / 10000 },
    memory: { gb: Math.round(memGb * 1000) / 1000, hourly: Math.round(memHourly * 10000) / 10000 },
    storage: { gb: Math.round(storageGb * 1000) / 1000, hourly: Math.round(storageHourly * 10000) / 10000 },
    totalHourly: Math.round(totalHourly * 10000) / 10000,
    totalMonthly: Math.round(totalHourly * 720 * 100) / 100,
  }
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
 * Prometheus 미응답 시 { items: [], notice } 반환 (graceful degradation)
 */
export async function getCost(
  scope: "cluster" | "namespace" | "service"
): Promise<{ items: CostItem[]; notice?: string }> {
  const cacheKey = `cost:${scope}:all`
  const cached = await cacheGet<{ items: CostItem[]; notice?: string }>(cacheKey)
  if (cached !== null) return cached

  try {
    if (scope === "cluster") {
      const [cpuRes, memRes, storRes] = await Promise.all([
        queryVector(cpuByNamespaceQuery()),
        queryVector(memByNamespaceQuery()),
        queryVector(storageByNamespaceQuery()),
      ])
      const cpuTotal = cpuRes.reduce((s, r) => s + parseFloat(r.value[1]), 0)
      const memTotal = memRes.reduce((s, r) => s + parseFloat(r.value[1]), 0)
      const storTotal = storRes.reduce((s, r) => s + parseFloat(r.value[1]), 0)
      const items = [calcItem("cluster", cpuTotal, memTotal, storTotal)]
      const result = { items }
      await cacheSet(cacheKey, result, 300) // 5min
      return result
    }

    if (scope === "namespace") {
      const [cpuRes, memRes, storRes] = await Promise.all([
        queryVector(cpuByNamespaceQuery()),
        queryVector(memByNamespaceQuery()),
        queryVector(storageByNamespaceQuery()),
      ])
      // namespace 맵 구성
      const cpuMap = new Map<string, number>()
      const memMap = new Map<string, number>()
      const storMap = new Map<string, number>()
      for (const r of cpuRes) {
        const ns = r.metric.namespace
        if (ns && ns !== "unknown") cpuMap.set(ns, parseFloat(r.value[1]))
      }
      for (const r of memRes) {
        const ns = r.metric.namespace
        if (ns && ns !== "unknown") memMap.set(ns, (memMap.get(ns) ?? 0) + parseFloat(r.value[1]))
      }
      for (const r of storRes) {
        const ns = r.metric.namespace
        if (ns && ns !== "unknown") storMap.set(ns, (storMap.get(ns) ?? 0) + parseFloat(r.value[1]))
      }
      const namespaces = new Set([...cpuMap.keys(), ...memMap.keys()])
      const items: CostItem[] = []
      for (const ns of namespaces) {
        items.push(calcItem(ns, cpuMap.get(ns) ?? 0, memMap.get(ns) ?? 0, storMap.get(ns) ?? 0))
      }
      items.sort((a, b) => b.totalHourly - a.totalHourly)
      const result = { items }
      await cacheSet(cacheKey, result, 300)
      return result
    }

    // scope === "service"
    const [cpuRes, memRes] = await Promise.all([
      queryVector(cpuByServiceQuery()),
      queryVector(memByServiceQuery()),
    ])
    const cpuMap = new Map<string, number>()
    const memMap = new Map<string, number>()
    for (const r of cpuRes) {
      const svc = r.metric.label_app_kubernetes_io_instance
      if (svc && svc !== "unknown" && svc !== "") {
        cpuMap.set(svc, parseFloat(r.value[1]))
      }
    }
    for (const r of memRes) {
      const svc = r.metric.label_app_kubernetes_io_instance
      if (svc && svc !== "unknown" && svc !== "") {
        memMap.set(svc, (memMap.get(svc) ?? 0) + parseFloat(r.value[1]))
      }
    }
    const services = new Set([...cpuMap.keys(), ...memMap.keys()])
    const items: CostItem[] = []
    for (const svc of services) {
      // service scope: storage는 PVC를 service에 매핑하기 어려우므로 0으로 처리
      items.push(calcItem(svc, cpuMap.get(svc) ?? 0, memMap.get(svc) ?? 0, 0))
    }
    if (items.length === 0) {
      const result = {
        items: [],
        notice: "label_app_kubernetes_io_instance 라벨이 없는 워크로드는 표시되지 않습니다. kube_pod_labels 메트릭 수집 여부를 확인하세요.",
      }
      await cacheSet(cacheKey, result, 300)
      return result
    }
    items.sort((a, b) => b.totalHourly - a.totalHourly)
    const result = { items }
    await cacheSet(cacheKey, result, 300)
    return result
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError"
    const notice = isTimeout
      ? "Prometheus 응답 시간 초과(5s). 잠시 후 다시 시도하세요."
      : "Prometheus 쿼리 실패. 메트릭 수집 서버 상태를 확인하세요."
    return { items: [], notice }
  }
}

/**
 * getCostByService: 단일 service 비용 + top 5 pods
 */
export async function getCostByService(serviceId: string): Promise<CostDetailResult | { notice: string }> {
  const cacheKey = `cost:service:${serviceId}`
  const cached = await cacheGet<CostDetailResult | { notice: string }>(cacheKey)
  if (cached !== null) return cached

  try {
    const [cpuRes, memRes, topCpuRes, topMemRes] = await Promise.all([
      queryVector(cpuByServiceQuery()),
      queryVector(memByServiceQuery()),
      queryVector(topPodCpuQuery(serviceId)),
      queryVector(topPodMemQuery(serviceId)),
    ])

    // 해당 service 항목 추출
    const cpuEntry = cpuRes.find((r) => r.metric.label_app_kubernetes_io_instance === serviceId)
    const memEntry = memRes.find((r) => r.metric.label_app_kubernetes_io_instance === serviceId)
    const cpuCores = cpuEntry ? parseFloat(cpuEntry.value[1]) : 0
    const memBytes = memEntry ? parseFloat(memEntry.value[1]) : 0

    const base = calcItem(serviceId, cpuCores, memBytes, 0)

    // top pods 구성 (pod별 cpu + mem, top 5)
    const podCpuMap = new Map<string, number>()
    const podMemMap = new Map<string, number>()
    for (const r of topCpuRes.slice(0, 10)) {
      const pod = r.metric.pod
      if (pod) podCpuMap.set(pod, parseFloat(r.value[1]))
    }
    for (const r of topMemRes.slice(0, 10)) {
      const pod = r.metric.pod
      if (pod) podMemMap.set(pod, parseFloat(r.value[1]))
    }
    const allPods = new Set([...podCpuMap.keys(), ...podMemMap.keys()])
    const topPods: TopPod[] = []
    for (const pod of allPods) {
      const podCpu = podCpuMap.get(pod) ?? 0
      const podMemGb = (podMemMap.get(pod) ?? 0) / 1e9
      const podHourly =
        podCpu * PRICES.cpuHourly + podMemGb * PRICES.memGbHourly
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
    }
    await cacheSet(cacheKey, result, 300)
    return result
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError"
    const notice = isTimeout
      ? "Prometheus 응답 시간 초과(5s). 잠시 후 다시 시도하세요."
      : "Prometheus 쿼리 실패. 메트릭 수집 서버 상태를 확인하세요."
    return { notice }
  }
}

/**
 * getCostTrend: 일별 비용 추이 (days일, 최대 90)
 * spec §4.4: avg_over_time(...[24h]) 슬라이딩 윈도, 30일 30 데이터포인트
 */
export async function getCostTrend(
  scope: "cluster" | "namespace" | "service",
  id: string,
  days: number
): Promise<{ points: CostTrendPoint[]; notice?: string }> {
  const safeDays = Math.min(days, 90)
  const cacheKey = `cost:trend:${scope}:${id}:${safeDays}`
  const cached = await cacheGet<{ points: CostTrendPoint[]; notice?: string }>(cacheKey)
  if (cached !== null) return cached

  try {
    const end = Math.floor(Date.now() / 1000)
    const start = end - safeDays * 86400
    const step = 86400 // 1일 step

    const [cpuRange, memRange] = await Promise.all([
      queryRangeVector(trendCpuQuery(scope, id), start, end, step),
      queryRangeVector(trendMemQuery(scope, id), start, end, step),
    ])

    // 첫 번째 series의 values 사용 (sum이라 시리즈 하나)
    const cpuValues = cpuRange[0]?.values ?? []
    const memValues = memRange[0]?.values ?? []

    // timestamp 기준 매핑
    const memMap = new Map<number, number>()
    for (const [ts, val] of memValues) {
      memMap.set(ts, parseFloat(val))
    }

    const points: CostTrendPoint[] = cpuValues.map(([ts, cpuVal]) => {
      const cpuCores = parseFloat(cpuVal)
      const memBytes = memMap.get(ts) ?? 0
      const totalHourly =
        cpuCores * PRICES.cpuHourly + (memBytes / 1e9) * PRICES.memGbHourly
      const date = new Date(ts * 1000).toISOString().slice(0, 10)
      return { date, total: Math.round(totalHourly * 10000) / 10000 }
    })

    const result = { points }
    await cacheSet(cacheKey, result, 3600) // 1hour
    return result
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError"
    const notice = isTimeout
      ? "Prometheus 응답 시간 초과(5s). 잠시 후 다시 시도하세요."
      : "Prometheus 쿼리 실패. 메트릭 수집 서버 상태를 확인하세요."
    return { points: [], notice }
  }
}
