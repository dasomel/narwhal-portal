import { cacheGet, cacheSet } from "./valkey"
import { assertPromQLSafe, K8S_NODE_NAME_RE } from "./validation"
import { getK8sApiServer, getDependencyUrl } from "./config"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

export type TelemetryStatus = "ok" | "empty" | "unavailable" | "partial" | "ambiguous" | "stale"
export type EvidenceSource = "prometheus" | "kubernetes" | "mixed" | "none"

export const STALENESS_THRESHOLD_SECONDS = 300 // 5 minutes

export interface PromQueryResult<T = number> {
  status: TelemetryStatus
  value: T | null
  seriesCount: number
  evaluatedAt: string
  query: string
  source: EvidenceSource
  error?: string
  warning?: string
}

export interface VectorMetricResult {
  metric: Record<string, string>
  value: number
  timestamp?: number
}

export interface PromVectorResult {
  status: TelemetryStatus
  results: VectorMetricResult[]
  seriesCount: number
  evaluatedAt: string
  query: string
  source: EvidenceSource
  error?: string
}

export interface RangeDataPoint {
  timestamp: number
  value: number
}

export interface PromRangeResult {
  status: TelemetryStatus
  data: RangeDataPoint[]
  seriesCount: number
  evaluatedAt: string
  query: string
  source: EvidenceSource
  error?: string
}

export interface NodeResourceMetric {
  cores?: number | null
  totalBytes?: number | null
  usagePercent: number | null
  status: TelemetryStatus
}

export interface NodeMetric {
  node: string
  role: string
  cpu: NodeResourceMetric
  memory: NodeResourceMetric
  disk: NodeResourceMetric
  status: TelemetryStatus
  evidenceSource: EvidenceSource
  evaluatedAt: string
}

export interface ClusterMetricComponent {
  status: TelemetryStatus
  query: string
  value: number | null
  source: EvidenceSource
  error?: string
}

export interface ClusterMetricsProjection {
  status: TelemetryStatus
  source: EvidenceSource
  evaluatedAt: string
  cpu: number | null
  memory: number | null
  nodes: {
    total: number | null
    ready: number | null
    source: EvidenceSource
    status: TelemetryStatus
  }
  pods: {
    total: number | null
    running: number | null
    source: EvidenceSource
    status: TelemetryStatus
  }
  components: {
    cpu: ClusterMetricComponent
    memory: ClusterMetricComponent
    nodeCount: ClusterMetricComponent
    nodeReady: ClusterMetricComponent
    podCount: ClusterMetricComponent
    podRunning: ClusterMetricComponent
  }
}

export type NodeMatchResult =
  | { matched: true; value: number; timestamp?: number; series: VectorMetricResult }
  | { matched: false; reason: "not_found" | "ambiguous" }

function prometheusUrl(): string {
  return getDependencyUrl("PROMETHEUS_URL", "http://localhost:9090")
}

/**
 * Deterministically match a node against vector metric results using canonical node identity.
 * Avoids loose prefix matching (e.g. 10.0.0.1 matching 10.0.0.10:9100) and detects ambiguous series.
 */
export function matchSeriesForNode(
  results: VectorMetricResult[] | undefined,
  nodeName: string,
  nodeIp?: string
): NodeMatchResult {
  if (!results || results.length === 0) return { matched: false, reason: "not_found" }

  // 1. Direct label: node="<nodeName>"
  const byNode = results.filter((r) => r.metric.node === nodeName)
  if (byNode.length === 1) {
    return { matched: true, value: byNode[0].value, timestamp: byNode[0].timestamp, series: byNode[0] }
  }
  if (byNode.length > 1) {
    return { matched: false, reason: "ambiguous" }
  }

  // 2. Direct label: nodename="<nodeName>"
  const byNodeName = results.filter((r) => r.metric.nodename === nodeName)
  if (byNodeName.length === 1) {
    return { matched: true, value: byNodeName[0].value, timestamp: byNodeName[0].timestamp, series: byNodeName[0] }
  }
  if (byNodeName.length > 1) {
    return { matched: false, reason: "ambiguous" }
  }

  // 3. instance label matching nodeName (exact or host part before :port)
  const byInstanceName = results.filter((r) => {
    const inst = r.metric.instance
    if (!inst) return false
    const host = inst.split(":")[0]
    return host === nodeName || inst === nodeName
  })
  if (byInstanceName.length === 1) {
    return { matched: true, value: byInstanceName[0].value, timestamp: byInstanceName[0].timestamp, series: byInstanceName[0] }
  }
  if (byInstanceName.length > 1) {
    return { matched: false, reason: "ambiguous" }
  }

  // 4. Exact IP match with host delimiter (NOT prefix matching like startsWith)
  if (nodeIp) {
    const byIp = results.filter((r) => {
      const inst = r.metric.instance
      if (!inst) return false
      const host = inst.split(":")[0]
      return host === nodeIp || inst === nodeIp
    })
    if (byIp.length === 1) {
      return { matched: true, value: byIp[0].value, timestamp: byIp[0].timestamp, series: byIp[0] }
    }
    if (byIp.length > 1) {
      return { matched: false, reason: "ambiguous" }
    }
  }

  return { matched: false, reason: "not_found" }
}

/**
 * Execute a scalar query returning explicit telemetry evidence (status, seriesCount, evaluatedAt, source).
 * Distinguishes 0 from empty, unavailable, stale, and ambiguous multi-series results.
 */
export async function queryScalarExplicit(
  promql: string,
  options?: {
    clusterId?: string
    maxAgeSeconds?: number
    allowMultiSeries?: boolean
  }
): Promise<PromQueryResult<number>> {
  assertPromQLSafe(promql)
  const clusterId = options?.clusterId ?? DEFAULT_CLUSTER_ID
  const cacheKey = `prom:${clusterId}:${promql}`
  const cached = await cacheGet<PromQueryResult<number>>(cacheKey)
  if (cached !== null) return cached

  const url = `${prometheusUrl()}/api/v1/query?query=${encodeURIComponent(promql)}`
  const evaluatedAt = new Date().toISOString()

  try {
    const res = await fetch(url, { next: { revalidate: 0 } })
    if (!res.ok) {
      return {
        status: "unavailable",
        value: null,
        seriesCount: 0,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        error: `Prometheus query failed: ${res.status}`,
      }
    }

    const data = await res.json()
    const results = data?.data?.result ?? []
    const seriesCount = results.length

    if (seriesCount === 0) {
      const emptyResult: PromQueryResult<number> = {
        status: "empty",
        value: null,
        seriesCount: 0,
        evaluatedAt,
        query: promql,
        source: "prometheus",
      }
      await cacheSet(cacheKey, emptyResult, 15)
      return emptyResult
    }

    if (seriesCount > 1 && !options?.allowMultiSeries) {
      return {
        status: "ambiguous",
        value: null,
        seriesCount,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        error: `Ambiguous scalar query returned ${seriesCount} series without aggregation`,
      }
    }

    const rawVal = results[0]?.value
    const ts = rawVal?.[0]
    const valStr = rawVal?.[1]

    if (valStr === undefined || valStr === "NaN") {
      return {
        status: "stale",
        value: null,
        seriesCount,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        warning: "Result value is NaN or undefined",
      }
    }

    const numVal = parseFloat(valStr)
    if (isNaN(numVal)) {
      return {
        status: "stale",
        value: null,
        seriesCount,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        warning: "Parsed value is NaN",
      }
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const maxAge = options?.maxAgeSeconds ?? STALENESS_THRESHOLD_SECONDS
    const isStale = typeof ts === "number" && nowSec - ts > maxAge

    const result: PromQueryResult<number> = {
      status: isStale ? "stale" : "ok",
      value: numVal,
      seriesCount,
      evaluatedAt,
      query: promql,
      source: "prometheus",
      ...(isStale ? { warning: `Telemetry is stale by ${Math.round(nowSec - ts)}s` } : {}),
    }

    await cacheSet(cacheKey, result, 15)
    return result
  } catch (err: unknown) {
    return {
      status: "unavailable",
      value: null,
      seriesCount: 0,
      evaluatedAt,
      query: promql,
      source: "prometheus",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Backwards-compatible scalar query wrapper.
 * Throws on failure or ambiguous/empty result instead of falsely returning 0.
 */
export async function query(promql: string, clusterId?: string): Promise<number> {
  const result = await queryScalarExplicit(promql, { clusterId })
  if (result.status !== "ok" && result.status !== "stale") {
    throw new Error(`Prometheus scalar query failed (${result.status}): ${promql}${result.error ? ` - ${result.error}` : ""}`)
  }
  return result.value ?? 0
}

/**
 * Execute a vector query returning explicit telemetry evidence.
 */
export async function queryVectorExplicit(
  promql: string,
  options?: { clusterId?: string; maxAgeSeconds?: number }
): Promise<PromVectorResult> {
  assertPromQLSafe(promql)
  const clusterId = options?.clusterId ?? DEFAULT_CLUSTER_ID
  const cacheKey = `promv:${clusterId}:${promql}`
  const cached = await cacheGet<PromVectorResult>(cacheKey)
  if (cached !== null) return cached

  const url = `${prometheusUrl()}/api/v1/query?query=${encodeURIComponent(promql)}`
  const evaluatedAt = new Date().toISOString()

  try {
    const res = await fetch(url, { next: { revalidate: 0 } })
    if (!res.ok) {
      return {
        status: "unavailable",
        results: [],
        seriesCount: 0,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        error: `Prometheus query failed: ${res.status}`,
      }
    }

    const data = await res.json()
    const rawResults = data?.data?.result ?? []
    const results: VectorMetricResult[] = rawResults.map(
      (r: { metric: Record<string, string>; value: [number, string] }) => ({
        metric: r.metric,
        value: parseFloat(r.value[1]),
        timestamp: r.value[0],
      })
    )

    const status: TelemetryStatus = results.length === 0 ? "empty" : "ok"
    const finalResult: PromVectorResult = {
      status,
      results,
      seriesCount: results.length,
      evaluatedAt,
      query: promql,
      source: "prometheus",
    }

    await cacheSet(cacheKey, finalResult, 15)
    return finalResult
  } catch (err: unknown) {
    return {
      status: "unavailable",
      results: [],
      seriesCount: 0,
      evaluatedAt,
      query: promql,
      source: "prometheus",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Backwards-compatible vector query wrapper.
 */
export async function queryVector(promql: string, clusterId?: string): Promise<VectorMetricResult[]> {
  const res = await queryVectorExplicit(promql, { clusterId })
  if (res.status === "unavailable") {
    throw new Error(`Prometheus query failed: ${res.error ?? "unavailable"}`)
  }
  return res.results
}

/**
 * Execute a range query returning explicit telemetry evidence.
 */
export async function queryRangeExplicit(
  promql: string,
  durationMinutes = 60,
  stepSeconds = 60,
  options?: { clusterId?: string }
): Promise<PromRangeResult> {
  assertPromQLSafe(promql)
  const clusterId = options?.clusterId ?? DEFAULT_CLUSTER_ID
  const cacheKey = `promr:${clusterId}:${promql}:${durationMinutes}`
  const cached = await cacheGet<PromRangeResult>(cacheKey)
  if (cached !== null) return cached

  const end = Math.floor(Date.now() / 1000)
  const start = end - durationMinutes * 60
  const url = `${prometheusUrl()}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=${stepSeconds}`
  const evaluatedAt = new Date().toISOString()

  try {
    const res = await fetch(url, { next: { revalidate: 0 } })
    if (!res.ok) {
      return {
        status: "unavailable",
        data: [],
        seriesCount: 0,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        error: `Prometheus range query failed: ${res.status}`,
      }
    }

    const data = await res.json()
    const rawResults = data?.data?.result ?? []
    const seriesCount = rawResults.length

    if (seriesCount === 0) {
      return {
        status: "empty",
        data: [],
        seriesCount: 0,
        evaluatedAt,
        query: promql,
        source: "prometheus",
      }
    }

    if (seriesCount > 1) {
      const values: [number, string][] = rawResults[0]?.values ?? []
      const points = values.map(([ts, val]) => ({ timestamp: ts, value: parseFloat(val) }))
      return {
        status: "ambiguous",
        data: points,
        seriesCount,
        evaluatedAt,
        query: promql,
        source: "prometheus",
        error: `Ambiguous range query returned ${seriesCount} series without aggregation`,
      }
    }

    const values: [number, string][] = rawResults[0]?.values ?? []
    const points = values.map(([ts, val]) => ({ timestamp: ts, value: parseFloat(val) }))
    const result: PromRangeResult = {
      status: "ok",
      data: points,
      seriesCount: 1,
      evaluatedAt,
      query: promql,
      source: "prometheus",
    }

    await cacheSet(cacheKey, result, 30)
    return result
  } catch (err: unknown) {
    return {
      status: "unavailable",
      data: [],
      seriesCount: 0,
      evaluatedAt,
      query: promql,
      source: "prometheus",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Backwards-compatible range query wrapper.
 */
export async function queryRange(
  promql: string,
  durationMinutes = 60,
  stepSeconds = 60,
  options?: { clusterId?: string }
): Promise<RangeDataPoint[]> {
  const res = await queryRangeExplicit(promql, durationMinutes, stepSeconds, options)
  return res.data
}

export async function getNodePodCountExplicit(
  nodeName: string,
  clusterId: string = DEFAULT_CLUSTER_ID
): Promise<PromQueryResult<number>> {
  if (!K8S_NODE_NAME_RE.test(nodeName) || nodeName.length > 253) {
    return {
      status: "empty",
      value: null,
      seriesCount: 0,
      evaluatedAt: new Date().toISOString(),
      query: `count(kube_pod_info{node="${nodeName}"})`,
      source: "prometheus",
      error: "Invalid node name",
    }
  }

  const res = await queryScalarExplicit(`count(kube_pod_info{node="${nodeName}"}) or vector(0)`, { clusterId })
  if (res.status === "ok" || res.status === "stale") {
    return {
      ...res,
      value: res.value !== null ? Math.round(res.value) : null,
    }
  }
  return res
}

export async function getNodePodCount(nodeName: string, clusterId: string = DEFAULT_CLUSTER_ID): Promise<number | null> {
  const res = await getNodePodCountExplicit(nodeName, clusterId)
  return res.value
}

/**
 * Get node metrics with deterministic canonical matching and explicit telemetry status.
 * Missing or failed queries preserve null rather than collapsing into 0.
 */
export async function getNodeMetrics(clusterId: string = DEFAULT_CLUSTER_ID): Promise<NodeMetric[]> {
  const cacheKey = `promnodemetrics:${clusterId}`
  const cached = await cacheGet<NodeMetric[]>(cacheKey)
  if (cached !== null) return cached

  const [nodeInfo, nodeRoles, cpuCores, cpuUsage, memTotal, memUsage, diskTotal, diskUsage] = await Promise.all([
    queryVectorExplicit("kube_node_info", { clusterId }),
    queryVectorExplicit("kube_node_role", { clusterId }),
    queryVectorExplicit('kube_node_status_capacity{resource="cpu"}', { clusterId }),
    queryVectorExplicit('100 - (avg by(instance)(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)', { clusterId }),
    queryVectorExplicit("node_memory_MemTotal_bytes", { clusterId }),
    queryVectorExplicit("(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100", { clusterId }),
    queryVectorExplicit('node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"}', { clusterId }),
    queryVectorExplicit(
      '(1 - node_filesystem_avail_bytes{mountpoint="/",fstype!="rootfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"}) * 100',
      { clusterId }
    ),
  ])

  if (nodeInfo.status === "unavailable") {
    return []
  }

  const nodes = nodeInfo.results
  const roleResults = nodeRoles.results
  const evaluatedAt = new Date().toISOString()

  const metrics: NodeMetric[] = nodes.map((n) => {
    const nodeName = n.metric.node ?? "unknown"
    const nodeIp = n.metric.internal_ip
    const roles = roleResults
      .filter((r) => r.metric.node === nodeName)
      .map((r) => r.metric.role)
      .filter(Boolean)
    const isControlPlane = roles.some((r) => r === "control-plane" || r === "master")
    const role = isControlPlane ? "control-plane" : (roles[0] ?? "worker")

    // Match each resource metric canonically
    const coresMatch = matchSeriesForNode(cpuCores.results, nodeName, nodeIp)
    const cpuPctMatch = matchSeriesForNode(cpuUsage.results, nodeName, nodeIp)
    const memTotalMatch = matchSeriesForNode(memTotal.results, nodeName, nodeIp)
    const memPctMatch = matchSeriesForNode(memUsage.results, nodeName, nodeIp)
    const diskTotalMatch = matchSeriesForNode(diskTotal.results, nodeName, nodeIp)
    const diskPctMatch = matchSeriesForNode(diskUsage.results, nodeName, nodeIp)

    const determineStatus = (
      queryRes: PromVectorResult,
      match: NodeMatchResult
    ): TelemetryStatus => {
      if (queryRes.status === "unavailable") return "unavailable"
      if (!match.matched) {
        return match.reason === "ambiguous" ? "ambiguous" : "empty"
      }
      return "ok"
    }

    const cpuStatus = determineStatus(cpuUsage, cpuPctMatch)
    const memStatus = determineStatus(memUsage, memPctMatch)
    const diskStatus = determineStatus(diskUsage, diskPctMatch)

    const okStatuses = [cpuStatus, memStatus, diskStatus].filter((s) => s === "ok").length
    const nodeStatus: TelemetryStatus =
      okStatuses === 3 ? "ok" : okStatuses > 0 ? "partial" : "unavailable"

    return {
      node: nodeName,
      role,
      cpu: {
        cores: coresMatch.matched ? coresMatch.value : null,
        usagePercent: cpuPctMatch.matched ? Math.round(cpuPctMatch.value) : null,
        status: cpuStatus,
      },
      memory: {
        totalBytes: memTotalMatch.matched ? memTotalMatch.value : null,
        usagePercent: memPctMatch.matched ? Math.round(memPctMatch.value) : null,
        status: memStatus,
      },
      disk: {
        totalBytes: diskTotalMatch.matched ? diskTotalMatch.value : null,
        usagePercent: diskPctMatch.matched ? Math.round(diskPctMatch.value) : null,
        status: diskStatus,
      },
      status: nodeStatus,
      evidenceSource: "prometheus",
      evaluatedAt,
    }
  })

  await cacheSet(cacheKey, metrics, 15)
  return metrics
}

/**
 * Fallback node/pod counts from the K8s API directly — used when
 * kube-state-metrics is unavailable or empty.
 */
async function k8sCountsFallback(): Promise<{
  nodes: { total: number; ready: number }
  pods: { total: number; running: number }
} | null> {
  try {
    const apiServer = getK8sApiServer()
    const [nodesRes, podsRes] = await Promise.all([
      fetch(`${apiServer}/api/v1/nodes`, { next: { revalidate: 10 } }),
      fetch(`${apiServer}/api/v1/pods`, { next: { revalidate: 10 } }),
    ])
    if (!nodesRes.ok || !podsRes.ok) return null
    const [nodes, pods] = await Promise.all([nodesRes.json(), podsRes.json()])
    const nodeItems: Array<{ status: { conditions: Array<{ type: string; status: string }> } }> = nodes.items ?? []
    const ready = nodeItems.filter((n) =>
      n.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
    ).length
    const podItems: Array<{ status: { phase: string } }> = pods.items ?? []
    const running = podItems.filter((p) => p.status?.phase === "Running").length
    return {
      nodes: { total: nodeItems.length, ready },
      pods: { total: podItems.length, running },
    }
  } catch {
    return null
  }
}

/**
 * Get cluster metrics projection with explicit source evidence, freshness, and component completeness.
 * Distinguishes telemetry failure from 0 and exposes Prometheus→Kubernetes fallback source.
 */
export async function getClusterMetrics(
  clusterId: string = DEFAULT_CLUSTER_ID
): Promise<ClusterMetricsProjection> {
  const cacheKey = `promcluster:${clusterId}`
  const cached = await cacheGet<ClusterMetricsProjection>(cacheKey)
  if (cached !== null) return cached

  const cpuQuery = '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'
  const memQuery = '(1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))) * 100'
  const nodeCountQuery = "count(kube_node_info)"
  const nodeReadyQuery = 'count(kube_node_status_condition{condition="Ready",status="true"})'
  const podCountQuery = "count(kube_pod_info)"
  const podRunningQuery = 'count(kube_pod_status_phase{phase="Running"})'

  const [cpuUsage, memUsage, nodeCount, nodeReady, podCount, podRunning] = await Promise.all([
    queryScalarExplicit(cpuQuery, { clusterId }),
    queryScalarExplicit(memQuery, { clusterId }),
    queryScalarExplicit(nodeCountQuery, { clusterId }),
    queryScalarExplicit(nodeReadyQuery, { clusterId }),
    queryScalarExplicit(podCountQuery, { clusterId }),
    queryScalarExplicit(podRunningQuery, { clusterId }),
  ])

  const promNodesOk = nodeCount.status === "ok"
  const promPodsOk = podCount.status === "ok"

  let fallback: Awaited<ReturnType<typeof k8sCountsFallback>> = null
  if (!promNodesOk || !promPodsOk) {
    fallback = await k8sCountsFallback()
  }

  const evaluatedAt = new Date().toISOString()

  const nodeSource: EvidenceSource = promNodesOk ? "prometheus" : fallback ? "kubernetes" : "none"
  const podSource: EvidenceSource = promPodsOk ? "prometheus" : fallback ? "kubernetes" : "none"

  const nodeStatus: TelemetryStatus = promNodesOk ? "ok" : fallback ? "ok" : nodeCount.status
  const podStatus: TelemetryStatus = promPodsOk ? "ok" : fallback ? "ok" : podCount.status

  const nodeTotal = promNodesOk ? nodeCount.value : (fallback?.nodes.total ?? null)
  const nodeReadyVal = promNodesOk ? nodeReady.value : (fallback?.nodes.ready ?? null)
  const podTotal = promPodsOk ? podCount.value : (fallback?.pods.total ?? null)
  const podRunningVal = promPodsOk ? podRunning.value : (fallback?.pods.running ?? null)

  const hasProm = cpuUsage.status === "ok" || memUsage.status === "ok" || promNodesOk || promPodsOk
  const hasK8s = fallback !== null

  let source: EvidenceSource = "none"
  if (hasProm && hasK8s) source = "mixed"
  else if (hasProm) source = "prometheus"
  else if (hasK8s) source = "kubernetes"

  const statuses = [cpuUsage.status, memUsage.status, nodeStatus, podStatus]
  const okCount = statuses.filter((s) => s === "ok").length
  const status: TelemetryStatus =
    okCount === 4 ? "ok" : okCount > 0 ? "partial" : "unavailable"

  const projection: ClusterMetricsProjection = {
    status,
    source,
    evaluatedAt,
    cpu: cpuUsage.status === "ok" && cpuUsage.value !== null ? Math.round(cpuUsage.value) : null,
    memory: memUsage.status === "ok" && memUsage.value !== null ? Math.round(memUsage.value) : null,
    nodes: {
      total: nodeTotal,
      ready: nodeReadyVal,
      source: nodeSource,
      status: nodeStatus,
    },
    pods: {
      total: podTotal,
      running: podRunningVal,
      source: podSource,
      status: podStatus,
    },
    components: {
      cpu: {
        status: cpuUsage.status,
        query: cpuQuery,
        value: cpuUsage.value,
        source: "prometheus",
        error: cpuUsage.error,
      },
      memory: {
        status: memUsage.status,
        query: memQuery,
        value: memUsage.value,
        source: "prometheus",
        error: memUsage.error,
      },
      nodeCount: {
        status: nodeStatus,
        query: nodeCountQuery,
        value: nodeTotal,
        source: nodeSource,
        error: nodeCount.error,
      },
      nodeReady: {
        status: nodeStatus,
        query: nodeReadyQuery,
        value: nodeReadyVal,
        source: nodeSource,
        error: nodeReady.error,
      },
      podCount: {
        status: podStatus,
        query: podCountQuery,
        value: podTotal,
        source: podSource,
        error: podCount.error,
      },
      podRunning: {
        status: podStatus,
        query: podRunningQuery,
        value: podRunningVal,
        source: podSource,
        error: podRunning.error,
      },
    },
  }

  await cacheSet(cacheKey, projection, 15)
  return projection
}
