import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { queryVector, getClusterMetrics } from "@/lib/prometheus"
import { getNamespaces, getAllPodsMinimal } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export interface NamespaceUsageV2 {
  namespace: string
  cpuPercent: number          // usage / requests * 100
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

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cacheKey = "governance:resources:v2"
  try {
    const cached = await cacheGet<ResourcesResponseV2>(cacheKey)
    if (cached) return NextResponse.json(cached)
  } catch (err) {
    console.warn("[governance/resources] Cache read failed (non-fatal):", err)
  }

  try {
    const namespaces = await getNamespaces()
    const userNs = namespaces.filter((n) => !n.name.startsWith("kube-") && n.name !== "default")

    const [
      podData,
      cpuUsedData,
      cpuReqData,
      memUsedData,
      memReqData,
      cpuPodData,
      memPodData,
      clusterMetrics,
      allK8sPods,
    ] = await Promise.all([
      queryVector("count by (namespace)(kube_pod_info)"),
      queryVector('sum by (namespace)(rate(container_cpu_usage_seconds_total{container!=""}[5m]))'),
      queryVector('sum by (namespace)(kube_pod_container_resource_requests{resource="cpu"})'),
      queryVector('sum by (namespace)(container_memory_working_set_bytes{container!=""})'),
      queryVector('sum by (namespace)(kube_pod_container_resource_requests{resource="memory"})'),

      queryVector(
        'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",namespace!~"kube.*"}[5m]))'
      ),
      queryVector(
        'sum by (namespace, pod) (container_memory_working_set_bytes{container!="",namespace!~"kube.*"})'
      ),
      getClusterMetrics(),
      getAllPodsMinimal(),
    ])

    const podByNs = Object.fromEntries(podData.map((r) => [r.metric.namespace, r.value]))
    const cpuUsedByNs = Object.fromEntries(cpuUsedData.map((r) => [r.metric.namespace, r.value]))
    const cpuReqByNs = Object.fromEntries(cpuReqData.map((r) => [r.metric.namespace, r.value]))
    const memUsedByNs = Object.fromEntries(memUsedData.map((r) => [r.metric.namespace, r.value]))
    const memReqByNs = Object.fromEntries(memReqData.map((r) => [r.metric.namespace, r.value]))

    // Count pods missing cpu or memory requests
    const noRequestPodsByNs: Record<string, number> = {}
    let clusterNoRequestPods = 0

    for (const pod of allK8sPods) {
      const ns = pod.metadata.namespace
      const containers = pod.spec?.containers || []
      const lacksRequests = containers.some((c) => {
        const req = c.resources?.requests
        return !req || !req.cpu || !req.memory
      })
      if (lacksRequests) {
        noRequestPodsByNs[ns] = (noRequestPodsByNs[ns] || 0) + 1
        clusterNoRequestPods++
      }
    }

    const resultNamespaces: NamespaceUsageV2[] = userNs.slice(0, 30).map((ns) => {
      const name = ns.name
      const cpuUsed = cpuUsedByNs[name] ?? 0
      const cpuReq = cpuReqByNs[name] ?? 0
      const memUsed = memUsedByNs[name] ?? 0
      const memReq = memReqByNs[name] ?? 0

      return {
        namespace: name,
        cpuPercent: cpuReq > 0 ? Math.round((cpuUsed / cpuReq) * 100) : 0,
        memoryPercent: memReq > 0 ? Math.round((memUsed / memReq) * 100) : 0,
        podCount: Math.round(podByNs[name] ?? 0),
        cpuUsedCores: Number(cpuUsed.toFixed(3)),
        cpuRequestedCores: Number(cpuReq.toFixed(3)),
        memUsedBytes: Math.round(memUsed),
        memRequestedBytes: Math.round(memReq),
        noRequestPods: noRequestPodsByNs[name] ?? 0,
      }
    })

    // Process top CPU and Memory pods
    const podMetricsMap = new Map<string, { cpu: number; mem: number }>()

    for (const r of cpuPodData) {
      const ns = r.metric.namespace
      const pod = r.metric.pod
      if (!ns || !pod) continue
      const key = `${ns}/${pod}`
      podMetricsMap.set(key, { cpu: r.value, mem: 0 })
    }

    for (const r of memPodData) {
      const ns = r.metric.namespace
      const pod = r.metric.pod
      if (!ns || !pod) continue
      const key = `${ns}/${pod}`
      const existing = podMetricsMap.get(key)
      if (existing) {
        existing.mem = r.value
      } else {
        podMetricsMap.set(key, { cpu: 0, mem: r.value })
      }
    }

    const allPods: TopPod[] = []
    for (const [key, val] of podMetricsMap.entries()) {
      const [namespace, pod] = key.split("/")
      allPods.push({
        namespace,
        pod,
        cpuCores: Number(val.cpu.toFixed(3)),
        memBytes: val.mem,
      })
    }

    const topCpuPods = [...allPods]
      .sort((a, b) => b.cpuCores - a.cpuCores)
      .slice(0, 10)

    const topMemPods = [...allPods]
      .sort((a, b) => b.memBytes - a.memBytes)
      .slice(0, 10)

    const response: ResourcesResponseV2 = {
      namespaces: resultNamespaces,
      topCpuPods,
      topMemPods,
      cluster: {
        cpuPercent: clusterMetrics.cpu ?? 0,
        memPercent: clusterMetrics.memory ?? 0,
        totalPods: clusterMetrics.pods?.total ?? 0,
        noRequestPods: clusterNoRequestPods,
      },
    }

    try {
      await cacheSet(cacheKey, response, 30)
    } catch (err) {
      console.warn("[governance/resources] Cache write failed (non-fatal):", err)
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error("[governance/resources]", err)
    return NextResponse.json({ error: "Failed to fetch resources data" }, { status: 500 })
  }
}
