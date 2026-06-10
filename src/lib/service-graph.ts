/**
 * Service Graph — Istio/Hubble 트래픽 실측 기반 서비스 의존성 그래프
 *
 * SERVICE_GRAPH_SOURCE=istio|hubble|both 환경변수로 소스 선택.
 * Prometheus 미응답 시 빈 그래프 + notice를 반환 (graceful degradation).
 */
import { cacheGet, cacheSet } from "./valkey"
import { getArgoApps } from "./argocd"
import type { ScoreTier } from "./argocd"

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090"

// 노이즈 필터 — 제외할 시스템 워크로드
const SYSTEM_WORKLOADS = new Set(["kubernetes", "coredns", "istiod", "unknown", ""])

// 허용 윈도우 값 — "1m"은 실시간(live) 모드 전용 순간 rate
export type GraphWindow = "1m" | "1h" | "1d" | "7d" | "30d"

export const ALLOWED_WINDOWS: readonly GraphWindow[] = ["1m", "1h", "1d", "7d", "30d"]

export function isAllowedWindow(v: unknown): v is GraphWindow {
  return typeof v === "string" && (ALLOWED_WINDOWS as readonly string[]).includes(v)
}

// ---------------------------------------------------------------------------
// 데이터 타입
// ---------------------------------------------------------------------------

export interface ServiceNode {
  id: string
  namespace: string
  status: "healthy" | "degraded" | "unknown"
  scoreTier?: ScoreTier
}

export interface ServiceEdge {
  source: string
  destination: string
  // 엣지별 단위: l7=req/s, l4=bytes/s. 없으면 응답의 metricKind를 따름.
  kind?: "l7" | "l4"
  requestRate: number // req/s (l7) 또는 bytes/s (l4), window 평균
  errorRate: number // 0..1
  p95LatencyMs?: number | null
}

export interface ServiceGraphResult {
  window: string
  generatedAt: string
  nodes: ServiceNode[]
  edges: ServiceEdge[]
  // ns 필터 적용 "이전" 전체 그래프에서 관측된 네임스페이스 목록 —
  // 드롭다운이 필터된 응답의 노드에서 목록을 뽑으면 선택할수록 목록이 줄어드는
  // 문제가 있어 서버가 항상 전체 목록을 내려준다.
  namespaces?: string[]
  // requestRate의 단위 판별용: l7=req/s, l4=bytes/s (UI가 단위를 맞춰 표시)
  metricKind?: "l7" | "l4" | "hubble" | "mixed"
  notice?: string
}

export interface ServiceDependenciesResult {
  serviceId: string
  inbound: Array<{ source: string; requestRate: number; errorRate: number; p95LatencyMs?: number | null }>
  outbound: Array<{ destination: string; requestRate: number; errorRate: number; p95LatencyMs?: number | null }>
  notice?: string
}

// ---------------------------------------------------------------------------
// Prometheus 쿼리 헬퍼
// ---------------------------------------------------------------------------

interface VectorResult {
  metric: Record<string, string>
  value: number
}

interface HistogramResult {
  metric: Record<string, string>
  value: number
}

// 7d/30d 윈도의 4중 병렬 쿼리가 5초를 넘기는 경우가 있어 10초로 상향 —
// 타임아웃 시 rawEdges=null → namespaces 없는 빈 응답이 내려가 UI가 깨졌었다.
async function queryPrometheus(promql: string, timeoutMs = 10000): Promise<VectorResult[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`
    const res = await fetch(url, { signal: controller.signal, next: { revalidate: 0 } })
    if (!res.ok) return null
    const data = await res.json()
    if (data?.status !== "success") return null
    return (data?.data?.result ?? []).map(
      (r: { metric: Record<string, string>; value: [number, string] }) => ({
        metric: r.metric,
        value: parseFloat(r.value[1]),
      }),
    )
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 워크로드 → 서비스 ID 매핑
// ---------------------------------------------------------------------------

/**
 * ArgoCD application name과 매핑:
 * - app.kubernetes.io/instance 라벨 우선
 * - fallback: app.kubernetes.io/name
 * - 매핑 실패 시 "unmapped-pods" 그룹
 */
export async function buildWorkloadToServiceMap(): Promise<Map<string, string>> {
  const apps = await getArgoApps()
  const appNames = new Set(apps.map((a) => a.metadata.name))
  // 워크로드 이름이 ArgoCD app name과 직접 일치하는 경우를 맵으로 구성
  const map = new Map<string, string>()
  for (const name of appNames) {
    map.set(name, name)
  }
  return map
}

export function resolveWorkload(workload: string, serviceMap: Map<string, string>): string {
  if (SYSTEM_WORKLOADS.has(workload)) return ""
  // ArgoCD app 이름과 직접 매핑 시도
  if (serviceMap.has(workload)) return serviceMap.get(workload)!
  // 워크로드 이름에서 deployment suffix 제거 시도 (e.g., my-app-7d9f5 → my-app)
  const withoutHash = workload.replace(/-[0-9a-f]{5,10}$/, "")
  if (serviceMap.has(withoutHash)) return serviceMap.get(withoutHash)!
  // 매핑 실패 → unmapped-pods 그룹
  return `unmapped-pods:${workload}`
}

// ---------------------------------------------------------------------------
// ArgoCD 상태 기반 노드 health 결정
// ---------------------------------------------------------------------------

async function buildNodeStatusMap(): Promise<Map<string, "healthy" | "degraded" | "unknown">> {
  const apps = await getArgoApps()
  const map = new Map<string, "healthy" | "degraded" | "unknown">()
  for (const app of apps) {
    const health = app.status.health.status
    if (health === "Healthy") map.set(app.metadata.name, "healthy")
    else if (health === "Degraded") map.set(app.metadata.name, "degraded")
    else map.set(app.metadata.name, "unknown")
  }
  return map
}

// ---------------------------------------------------------------------------
// 노이즈 필터
// ---------------------------------------------------------------------------

const MIN_RATE = 0.01 // req/s

function isSystemWorkload(name: string): boolean {
  return SYSTEM_WORKLOADS.has(name.toLowerCase())
}

function isHealthCheckPath(labels: Record<string, string>): boolean {
  const path = labels["request_path"] ?? labels["path"] ?? ""
  return ["/healthz", "/readyz", "/metrics", "/livez"].includes(path)
}

// ---------------------------------------------------------------------------
// Istio PromQL 쿼리
// ---------------------------------------------------------------------------

function buildIstioRateQuery(window: GraphWindow): string {
  // spec §4.3: source_workload, destination_workload 집계
  // NOTE: PromQL 라벨 매처는 라벨↔문자열 비교만 지원하므로 source_workload!=destination_workload
  // (라벨↔라벨) 매처는 사용 불가 — self-call 제외는 코드(srcId===dstId)에서 처리한다.
  return `sum by (source_workload, destination_workload, source_workload_namespace, destination_workload_namespace) (rate(istio_requests_total{source_workload!="unknown",destination_workload!="unknown"}[${window}]))`
}

function buildIstioErrorRateQuery(window: GraphWindow): string {
  return `sum by (source_workload, destination_workload) (rate(istio_requests_total{response_code=~"5..",source_workload!="unknown",destination_workload!="unknown"}[${window}]))`
}

function buildIstiop95LatencyQuery(window: GraphWindow): string {
  return `histogram_quantile(0.95, sum by (source_workload, destination_workload, le) (rate(istio_request_duration_milliseconds_bucket{source_workload!="unknown",destination_workload!="unknown"}[${window}])))`
}

// ---------------------------------------------------------------------------
// Istio L4 (TCP) PromQL — ambient mode without waypoints
// ---------------------------------------------------------------------------
// In Istio ambient mode ztunnel emits only L4 telemetry (istio_tcp_*); L7
// metrics (istio_requests_total / istio_request_duration_*) require waypoint
// proxies which are not deployed. We build edges from TCP byte counters, which
// carry the same source_workload/destination_workload labels.
//
// Edge weight = bytes/sec (rate of istio_tcp_sent_bytes_total). We deliberately
// do NOT use istio_tcp_connections_opened_total: ambient connections are
// long-lived, so the rate of NEW connections decays to ~0 over the portal's
// default 7d window (every edge would be filtered out by MIN_RATE). Sent-bytes
// rate stays representative of an active dependency across all windows.
//
// requestRate here is bytes/sec (edge weight), not HTTP req/s. TCP telemetry
// has no response_code or request latency, so errorRate=0 and p95LatencyMs=null.

function buildIstioTcpRateQuery(window: GraphWindow): string {
  // self-call 제외는 코드(srcId===dstId)에서 처리 — PromQL은 라벨↔라벨 매처 미지원.
  return `sum by (source_workload, destination_workload, source_workload_namespace, destination_workload_namespace) (rate(istio_tcp_sent_bytes_total{source_workload!="unknown",destination_workload!="unknown"}[${window}]))`
}

// ---------------------------------------------------------------------------
// Hubble PromQL 쿼리 (mTLS 미적용 워크로드 fallback)
// ---------------------------------------------------------------------------

function buildHubbleRateQuery(window: GraphWindow): string {
  return `sum by (source, destination) (rate(hubble_flows_processed_total{verdict="FORWARDED"}[${window}]))`
}

// ---------------------------------------------------------------------------
// 그래프 빌드 핵심 로직
// ---------------------------------------------------------------------------

interface RawEdge {
  source: string
  destination: string
  // istio 메트릭의 source/destination_workload_namespace 라벨 (hubble은 미제공)
  sourceNamespace?: string
  destinationNamespace?: string
  // 엣지별 메트릭 종류 — l7=req/s, l4=bytes/s (waypoint 부분 적용 시 혼합 그래프)
  kind?: "l7" | "l4"
  requestRate: number
  errorRate: number
  p95LatencyMs?: number | null
}

async function buildEdgesFromIstio(window: GraphWindow): Promise<RawEdge[] | null> {
  const [rateResults, errorResults, latencyResults] = await Promise.all([
    queryPrometheus(buildIstioRateQuery(window)),
    queryPrometheus(buildIstioErrorRateQuery(window)),
    queryPrometheus(buildIstiop95LatencyQuery(window)),
  ])

  if (!rateResults) return null

  // 에러율 맵 구성: source:destination → errorRate
  const errorMap = new Map<string, number>()
  if (errorResults) {
    for (const r of errorResults) {
      const src = r.metric["source_workload"] ?? ""
      const dst = r.metric["destination_workload"] ?? ""
      if (src && dst) errorMap.set(`${src}:${dst}`, r.value)
    }
  }

  // p95 latency 맵
  const latencyMap = new Map<string, number>()
  if (latencyResults) {
    for (const r of latencyResults) {
      const src = r.metric["source_workload"] ?? ""
      const dst = r.metric["destination_workload"] ?? ""
      if (src && dst) {
        // Prometheus는 초 단위로 반환 → ms로 변환
        latencyMap.set(`${src}:${dst}`, r.value * 1000)
      }
    }
  }

  const edges: RawEdge[] = []
  for (const r of rateResults) {
    const src = r.metric["source_workload"] ?? ""
    const dst = r.metric["destination_workload"] ?? ""
    const dstService = r.metric["destination_service_name"] ?? ""

    // 노이즈 필터
    if (!src || !dst) continue
    if (isSystemWorkload(src) || isSystemWorkload(dst)) continue
    if (["kubernetes", "coredns", "istiod"].includes(dstService)) continue
    if (isHealthCheckPath(r.metric)) continue
    if (r.value < MIN_RATE) continue

    const key = `${src}:${dst}`
    const totalRate = r.value
    const errRate = errorMap.get(key) ?? 0
    const errorRate = totalRate > 0 ? Math.min(errRate / totalRate, 1) : 0
    const latencyVal = latencyMap.get(key)

    edges.push({
      source: src,
      destination: dst,
      sourceNamespace: r.metric["source_workload_namespace"] || undefined,
      destinationNamespace: r.metric["destination_workload_namespace"] || undefined,
      kind: "l7",
      requestRate: r.value,
      errorRate,
      p95LatencyMs: latencyVal != null && isFinite(latencyVal) ? latencyVal : null,
    })
  }

  return edges
}

async function buildEdgesFromIstioTcp(window: GraphWindow): Promise<RawEdge[] | null> {
  const rateResults = await queryPrometheus(buildIstioTcpRateQuery(window))
  if (!rateResults) return null

  const edges: RawEdge[] = []
  for (const r of rateResults) {
    const src = r.metric["source_workload"] ?? ""
    const dst = r.metric["destination_workload"] ?? ""
    const dstService = r.metric["destination_service_name"] ?? ""

    // 노이즈 필터 (L4는 request_path가 없으므로 health-check 필터는 미적용)
    if (!src || !dst) continue
    if (isSystemWorkload(src) || isSystemWorkload(dst)) continue
    if (["kubernetes", "coredns", "istiod"].includes(dstService)) continue
    if (r.value < MIN_RATE) continue

    edges.push({
      source: src,
      destination: dst,
      sourceNamespace: r.metric["source_workload_namespace"] || undefined,
      destinationNamespace: r.metric["destination_workload_namespace"] || undefined,
      kind: "l4",
      requestRate: r.value, // bytes/sec (L4 edge weight, istio_tcp_sent_bytes_total)
      errorRate: 0, // TCP 텔레메트리는 response_code 미제공
      p95LatencyMs: null, // L4는 요청 지연 메트릭 없음
    })
  }

  return edges
}

async function buildEdgesFromHubble(window: GraphWindow): Promise<RawEdge[] | null> {
  const rateResults = await queryPrometheus(buildHubbleRateQuery(window))
  if (!rateResults) return null

  const edges: RawEdge[] = []
  for (const r of rateResults) {
    const src = r.metric["source"] ?? ""
    const dst = r.metric["destination"] ?? ""

    if (!src || !dst || src === "unknown" || dst === "unknown") continue
    if (isSystemWorkload(src) || isSystemWorkload(dst)) continue
    if (r.value < MIN_RATE) continue

    edges.push({
      source: src,
      destination: dst,
      requestRate: r.value,
      errorRate: 0, // Hubble는 에러율 미제공
      p95LatencyMs: null,
    })
  }

  return edges
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 전체 서비스 그래프를 반환.
 * Prometheus 미응답 시 빈 그래프 + notice 반환 (graceful degradation).
 */
export async function getServiceGraph(
  window: GraphWindow,
  namespace?: string,
  minRate: number = MIN_RATE,
): Promise<ServiceGraphResult> {
  const cacheKey = `graph:cluster:${window}:${namespace ?? "all"}`
  const cached = await cacheGet<ServiceGraphResult>(cacheKey)
  if (cached) return cached

  const source = process.env.SERVICE_GRAPH_SOURCE ?? "istio"
  const generatedAt = new Date().toISOString()

  // 워크로드 → 서비스 매핑, 노드 상태 맵 동시 로드
  const [serviceMap, statusMap] = await Promise.all([buildWorkloadToServiceMap(), buildNodeStatusMap()])

  let rawEdges: RawEdge[] | null = null
  let metricKind: "l7" | "l4" | "hubble" | "mixed" = "l7"

  if (source === "istio") {
    // Ambient 모드: L7(istio_requests_total)은 waypoint가 있는 ns에서만 생성됨.
    // waypoint 부분 적용 상태를 고려해 L7 + L4를 병합한다 —
    // 같은 (src,dst) 쌍은 L7 우선(정확한 req/s + 에러율 + p95), 나머지는 L4 유지.
    const [l7, l4] = await Promise.all([buildEdgesFromIstio(window), buildEdgesFromIstioTcp(window)])
    if (l7 === null && l4 === null) {
      rawEdges = null
    } else {
      const l7e = l7 ?? []
      const l4e = l4 ?? []
      const covered = new Set(l7e.map((e) => `${e.source}|${e.destination}`))
      rawEdges = [...l7e, ...l4e.filter((e) => !covered.has(`${e.source}|${e.destination}`))]
      metricKind = l7e.length === 0 ? "l4" : rawEdges.length > l7e.length ? "mixed" : "l7"
    }
  } else if (source === "istio-tcp") {
    rawEdges = await buildEdgesFromIstioTcp(window)
    metricKind = "l4"
  } else if (source === "hubble") {
    rawEdges = await buildEdgesFromHubble(window)
    metricKind = "hubble"
  } else if (source === "both") {
    const [istioEdges, hubbleEdges] = await Promise.all([
      buildEdgesFromIstio(window),
      buildEdgesFromHubble(window),
    ])
    // 둘 다 실패 시 null
    if (istioEdges || hubbleEdges) {
      rawEdges = [...(istioEdges ?? []), ...(hubbleEdges ?? [])]
      metricKind = "mixed"
    }
  }

  // Prometheus 미응답 → 빈 그래프 + notice
  if (rawEdges === null) {
    const result: ServiceGraphResult = {
      window,
      generatedAt,
      nodes: [],
      edges: [],
      notice: "Prometheus 미응답 — 서비스 그래프를 일시적으로 표시할 수 없습니다.",
    }
    return result
  }

  // minRate 필터 추가 적용
  const filtered = rawEdges.filter((e) => e.requestRate >= minRate)

  // 전체 네임스페이스 목록 (ns 필터 적용 전 기준 — 드롭다운용)
  const allNamespaces = Array.from(
    new Set(
      filtered.flatMap((e) => [e.sourceNamespace, e.destinationNamespace]).filter((ns): ns is string => !!ns),
    ),
  ).sort()

  // namespace 필터: 메트릭 라벨(source/destination_workload_namespace) 기준.
  // 해당 ns가 출발 또는 도착에 걸치는 엣지를 포함해 경계 트래픽도 보이게 한다.
  // (hubble 등 ns 라벨이 없는 소스는 필터를 통과시키지 않음)
  const nsFiltered = namespace
    ? filtered.filter((e) => e.sourceNamespace === namespace || e.destinationNamespace === namespace)
    : filtered

  // 노드 집합 구성 + 노드별 실제 namespace 수집 (메트릭 라벨에서)
  const nodeIds = new Set<string>()
  const nodeNs = new Map<string, string>()
  const edges: ServiceEdge[] = []

  for (const e of nsFiltered) {
    const srcId = resolveWorkload(e.source, serviceMap)
    const dstId = resolveWorkload(e.destination, serviceMap)

    if (!srcId || !dstId) continue
    if (srcId === dstId) continue // self-call 제외

    nodeIds.add(srcId)
    nodeIds.add(dstId)
    if (e.sourceNamespace && !nodeNs.has(srcId)) nodeNs.set(srcId, e.sourceNamespace)
    if (e.destinationNamespace && !nodeNs.has(dstId)) nodeNs.set(dstId, e.destinationNamespace)

    edges.push({
      source: srcId,
      destination: dstId,
      ...(e.kind ? { kind: e.kind } : {}),
      requestRate: Math.round(e.requestRate * 1000) / 1000,
      errorRate: Math.round(e.errorRate * 10000) / 10000,
      p95LatencyMs: e.p95LatencyMs != null ? Math.round(e.p95LatencyMs) : null,
    })
  }

  const nodes: ServiceNode[] = Array.from(nodeIds).map((id) => ({
    id,
    // 메트릭 라벨 기반 실제 ns. 라벨이 없는 소스(hubble 등)는 "unknown".
    namespace: nodeNs.get(id) ?? "unknown",
    status: statusMap.get(id) ?? "unknown",
  }))

  const result: ServiceGraphResult = {
    window,
    generatedAt,
    nodes,
    edges,
    namespaces: allNamespaces,
    metricKind,
  }

  // 1분 TTL (spec §4.5). 실시간(1m) 모드는 5초 — 폴링 주기와 맞춤.
  await cacheSet(cacheKey, result, window === "1m" ? 5 : 60)
  return result
}

/**
 * 특정 서비스의 inbound/outbound 의존성을 반환.
 */
export async function getServiceDependencies(
  serviceId: string,
  window: GraphWindow,
): Promise<ServiceDependenciesResult> {
  const cacheKey = `graph:svc:${serviceId}:${window}`
  const cached = await cacheGet<ServiceDependenciesResult>(cacheKey)
  if (cached) return cached

  const graph = await getServiceGraph(window)

  if (graph.notice && graph.edges.length === 0) {
    const result: ServiceDependenciesResult = {
      serviceId,
      inbound: [],
      outbound: [],
      notice: graph.notice,
    }
    return result
  }

  const inbound = graph.edges
    .filter((e) => e.destination === serviceId)
    .map((e) => ({
      source: e.source,
      requestRate: e.requestRate,
      errorRate: e.errorRate,
      p95LatencyMs: e.p95LatencyMs,
    }))

  const outbound = graph.edges
    .filter((e) => e.source === serviceId)
    .map((e) => ({
      destination: e.destination,
      requestRate: e.requestRate,
      errorRate: e.errorRate,
      p95LatencyMs: e.p95LatencyMs,
    }))

  const result: ServiceDependenciesResult = {
    serviceId,
    inbound,
    outbound,
  }

  // 1분 TTL (spec §4.5)
  await cacheSet(cacheKey, result, 60)
  return result
}
