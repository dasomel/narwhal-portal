import { cacheGet, cacheSet } from "./valkey"
import { assertPromQLSafe, K8S_NODE_NAME_RE } from "./validation"
import { K8S_API_SERVER } from "./config"

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090"

async function query(promql: string): Promise<number> {
  // M-1: PromQL safety — defense in depth. Callers should already supply
  // pre-defined templates with sanitized parameters.
  assertPromQLSafe(promql)
  const cached = await cacheGet<number>(`prom:${promql}`)
  if (cached !== null) return cached

  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`
  const res = await fetch(url, { next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`)
  const data = await res.json()
  const value = parseFloat(data?.data?.result?.[0]?.value?.[1] ?? "0")
  await cacheSet(`prom:${promql}`, value, 15)
  return value
}

interface VectorResult {
  metric: Record<string, string>
  value: number
}

export async function queryVector(promql: string): Promise<VectorResult[]> {
  assertPromQLSafe(promql)
  const cached = await cacheGet<VectorResult[]>(`promv:${promql}`)
  if (cached !== null) return cached

  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(promql)}`
  const res = await fetch(url, { next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`)
  const data = await res.json()
  const results = (data?.data?.result ?? []).map((r: { metric: Record<string, string>; value: [number, string] }) => ({
    metric: r.metric,
    value: parseFloat(r.value[1]),
  }))
  await cacheSet(`promv:${promql}`, results, 15)
  return results
}

export interface NodeMetric {
  node: string
  role: string
  cpu: { cores: number; usagePercent: number }
  memory: { totalBytes: number; usagePercent: number }
  disk: { totalBytes: number; usagePercent: number }
}

export async function getNodeMetrics(): Promise<NodeMetric[]> {
  const [nodeInfo, cpuCores, cpuUsage, memTotal, memUsage, diskTotal, diskUsage] = await Promise.allSettled([
    queryVector('kube_node_info'),
    queryVector('kube_node_status_capacity{resource="cpu"}'),
    queryVector('100 - (avg by(instance)(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'),
    queryVector('node_memory_MemTotal_bytes'),
    queryVector('(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100'),
    queryVector('node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"}'),
    queryVector('(1 - node_filesystem_avail_bytes{mountpoint="/",fstype!="rootfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="rootfs"}) * 100'),
  ])

  const nodes = nodeInfo.status === "fulfilled" ? nodeInfo.value : []

  function findByNode(results: VectorResult[] | undefined, nodeName: string, nodeIp?: string): number | null {
    if (!results) return null
    const byNode = results.find((r) => r.metric.node === nodeName)
    if (byNode) return byNode.value
    if (nodeIp) {
      const byIp = results.find((r) => r.metric.instance?.startsWith(nodeIp))
      if (byIp) return byIp.value
    }
    return null
  }

  return nodes.map((n) => {
    const nodeName = n.metric.node ?? "unknown"
    const nodeIp = n.metric.internal_ip
    const roles = Object.keys(n.metric)
      .filter((k) => k.startsWith("label_node_role_kubernetes_io_"))
      .map((k) => k.replace("label_node_role_kubernetes_io_", ""))
    const role = roles.includes("control-plane") ? "control-plane" : roles[0] ?? "worker"

    const cores = findByNode(cpuCores.status === "fulfilled" ? cpuCores.value : undefined, nodeName, nodeIp)
    const cpuPct = findByNode(cpuUsage.status === "fulfilled" ? cpuUsage.value : undefined, nodeName, nodeIp)
    const memTotalVal = findByNode(memTotal.status === "fulfilled" ? memTotal.value : undefined, nodeName, nodeIp)
    const memPct = findByNode(memUsage.status === "fulfilled" ? memUsage.value : undefined, nodeName, nodeIp)
    const diskTotalVal = findByNode(diskTotal.status === "fulfilled" ? diskTotal.value : undefined, nodeName, nodeIp)
    const diskPct = findByNode(diskUsage.status === "fulfilled" ? diskUsage.value : undefined, nodeName, nodeIp)

    return {
      node: nodeName,
      role,
      cpu: { cores: cores ?? 0, usagePercent: Math.round(cpuPct ?? 0) },
      memory: { totalBytes: memTotalVal ?? 0, usagePercent: Math.round(memPct ?? 0) },
      disk: { totalBytes: diskTotalVal ?? 0, usagePercent: Math.round(diskPct ?? 0) },
    }
  })
}

export interface RangeDataPoint {
  timestamp: number
  value: number
}

export async function queryRange(
  promql: string,
  durationMinutes = 60,
  stepSeconds = 60
): Promise<RangeDataPoint[]> {
  assertPromQLSafe(promql)
  const cacheKey = `promr:${promql}:${durationMinutes}`
  const cached = await cacheGet<RangeDataPoint[]>(cacheKey)
  if (cached) return cached

  const end = Math.floor(Date.now() / 1000)
  const start = end - durationMinutes * 60
  const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=${stepSeconds}`

  try {
    const res = await fetch(url, { next: { revalidate: 0 } })
    if (!res.ok) return []
    const data = await res.json()
    const values: [number, string][] = data?.data?.result?.[0]?.values ?? []
    const points = values.map(([ts, val]) => ({ timestamp: ts, value: parseFloat(val) }))
    await cacheSet(cacheKey, points, 30)
    return points
  } catch {
    return []
  }
}

export async function getNodePodCount(nodeName: string): Promise<number> {
  if (!K8S_NODE_NAME_RE.test(nodeName) || nodeName.length > 253) return 0
  try {
    const results = await queryVector(`count(kube_pod_info{node="${nodeName}"})`)
    return Math.round(results[0]?.value ?? 0)
  } catch {
    return 0
  }
}

/**
 * Fallback node/pod counts from the K8s API directly — used when
 * kube-state-metrics is unavailable (the kube_* queries return 0/empty).
 */
async function k8sCountsFallback(): Promise<{
  nodes: { total: number; ready: number }
  pods: { total: number; running: number }
} | null> {
  try {
    const [nodesRes, podsRes] = await Promise.all([
      fetch(`${K8S_API_SERVER}/api/v1/nodes`, { next: { revalidate: 10 } }),
      fetch(`${K8S_API_SERVER}/api/v1/pods`, { next: { revalidate: 10 } }),
    ])
    if (!nodesRes.ok || !podsRes.ok) return null
    const [nodes, pods] = await Promise.all([nodesRes.json(), podsRes.json()])
    const nodeItems: Array<{ status: { conditions: Array<{ type: string; status: string }> } }> = nodes.items ?? []
    const ready = nodeItems.filter((n) =>
      n.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
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

export async function getClusterMetrics() {
  const [cpuUsage, memUsage, nodeCount, nodeReady, podCount, podRunning] = await Promise.allSettled([
    query('100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'),
    query('(1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))) * 100'),
    query('count(kube_node_info)'),
    query('count(kube_node_status_condition{condition="Ready",status="true"})'),
    query('count(kube_pod_info)'),
    query('count(kube_pod_status_phase{phase="Running"})'),
  ])

  const promNodeTotal = nodeCount.status === "fulfilled" ? nodeCount.value : 0
  const promPodTotal = podCount.status === "fulfilled" ? podCount.value : 0

  // Fall back to K8s API when kube-state-metrics yields nothing.
  let fallback: Awaited<ReturnType<typeof k8sCountsFallback>> = null
  if (promNodeTotal === 0 || promPodTotal === 0) {
    fallback = await k8sCountsFallback()
  }

  return {
    cpu: cpuUsage.status === "fulfilled" ? Math.round(cpuUsage.value) : null,
    memory: memUsage.status === "fulfilled" ? Math.round(memUsage.value) : null,
    nodes: {
      total: fallback?.nodes.total ?? (nodeCount.status === "fulfilled" ? nodeCount.value : null),
      ready: fallback?.nodes.ready ?? (nodeReady.status === "fulfilled" ? nodeReady.value : null),
    },
    pods: {
      total: fallback?.pods.total ?? (podCount.status === "fulfilled" ? podCount.value : null),
      running: fallback?.pods.running ?? (podRunning.status === "fulfilled" ? podRunning.value : null),
    },
  }
}
