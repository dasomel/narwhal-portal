import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { queryVector, getClusterMetrics } from "@/lib/prometheus"
import { getNamespaces, getAllPodsMinimal } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"

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

export interface NoRequestPod {
  namespace: string
  pod: string
  containers: string[]
}

export interface ResourcesResponseV2 {
  namespaces: NamespaceUsageV2[]
  topCpuPods: TopPod[]        // top 10 by cpu usage, cluster-wide (exclude kube-*)
  topMemPods: TopPod[]        // top 10 by memory
  cluster: {
    cpuPercent: number
    memPercent: number
    totalPods: number
    noRequestPods: number
    /**
     * cpuPercent/memPercent mean different things depending on the caller's scope, and
     * the UI must label them accordingly instead of showing the same "CPU Usage" caption
     * for both: "cluster-capacity" (scope.all) is usage against total node capacity
     * (getClusterMetrics), "visible-requests" (scoped) is usage against the SUM OF
     * REQUESTS across the caller's own visible namespaces — a different denominator, not
     * just a filtered version of the same number.
     */
    basis: "cluster-capacity" | "visible-requests"
  }
  noRequestPodsList: NoRequestPod[]
  /**
   * portal#52: true when the cluster-wide pod list hit its page cap — noRequestPods/topPods
   * are then a partial view, not the full cluster.
   *
   * For a scoped caller this is NOT simply passed through: the raw cluster-wide flag would
   * leak whether the whole cluster's pod count is large enough to hit the page cap, which is
   * information about namespaces outside their scope. Instead it is derived from a
   * scope-safe comparison (see `scopedTruncated` below) — true only when the caller's OWN
   * visible namespaces demonstrably lost pods, which they are entitled to know.
   */
  truncated: boolean
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Non-admins reach this tab too (nav gates /governance to
  // cluster-admin/developer/viewer, not admin-only — contrast /api/governance/audit's
  // requireRole("cluster-admin")), so the response must be filtered to the caller's
  // effective scope the same way scorecard/dora do. The cache key carries the scope
  // fingerprint so a scoped result never leaks to a different caller.
  const scope = await getEffectiveScope(session)
  const cacheKey = `governance:resources:v3:${scope.fingerprint}`
  try {
    const cached = await cacheGet<ResourcesResponseV2>(cacheKey)
    if (cached) return NextResponse.json(cached)
  } catch (err) {
    console.warn("[governance/resources] Cache read failed (non-fatal):", err)
  }

  try {
    const namespaces = await getNamespaces()
    const userNs = namespaces.filter(
      (n) => !n.name.startsWith("kube-") && n.name !== "default" && namespaceVisible(n.name, scope)
    )

    const [
      podData,
      cpuUsedData,
      cpuReqData,
      memUsedData,
      memReqData,
      cpuPodData,
      memPodData,
      clusterMetrics,
      allPodsResult,
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
    const allK8sPods = allPodsResult.items

    const podByNs = Object.fromEntries(podData.map((r) => [r.metric.namespace, r.value]))
    const cpuUsedByNs = Object.fromEntries(cpuUsedData.map((r) => [r.metric.namespace, r.value]))
    const cpuReqByNs = Object.fromEntries(cpuReqData.map((r) => [r.metric.namespace, r.value]))
    const memUsedByNs = Object.fromEntries(memUsedData.map((r) => [r.metric.namespace, r.value]))
    const memReqByNs = Object.fromEntries(memReqData.map((r) => [r.metric.namespace, r.value]))

    // Count pods missing cpu or memory requests
    const noRequestPodsByNs: Record<string, number> = {}
    let clusterNoRequestPods = 0
    const noRequestPodsList: NoRequestPod[] = []
    // How many of the (possibly truncated) k8s API pod list's items actually belong to
    // each visible namespace — compared below against podByNs (Prometheus's independent,
    // always-complete kube_pod_info count) to detect whether truncation cost THIS caller
    // any of their own pods, without ever comparing namespaces outside their scope.
    const actualPodCountByNs: Record<string, number> = {}

    for (const pod of allK8sPods) {
      const ns = pod.metadata.namespace || ""
      if (!namespaceVisible(ns, scope)) continue
      actualPodCountByNs[ns] = (actualPodCountByNs[ns] || 0) + 1
      const podName = pod.metadata.name || ""
      const containers = pod.spec?.containers || []

      const missingContainers: string[] = []
      for (const c of containers) {
        const req = c.resources?.requests
        if (!req || !req.cpu || !req.memory) {
          missingContainers.push(c.name || "")
        }
      }

      if (missingContainers.length > 0) {
        noRequestPodsByNs[ns] = (noRequestPodsByNs[ns] || 0) + 1
        clusterNoRequestPods++
        noRequestPodsList.push({
          namespace: ns,
          pod: podName,
          containers: missingContainers,
        })
      }
    }

    noRequestPodsList.sort((a, b) => {
      const nsCompare = a.namespace.localeCompare(b.namespace)
      if (nsCompare !== 0) return nsCompare
      return a.pod.localeCompare(b.pod)
    })

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
      if (!ns || !pod || !namespaceVisible(ns, scope)) continue
      const key = `${ns}/${pod}`
      podMetricsMap.set(key, { cpu: r.value, mem: 0 })
    }

    for (const r of memPodData) {
      const ns = r.metric.namespace
      const pod = r.metric.pod
      if (!ns || !pod || !namespaceVisible(ns, scope)) continue
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

    // clusterMetrics is a genuinely cluster-wide summary (getClusterMetrics), which is
    // correct only when the caller may see the whole cluster. A scoped caller instead
    // gets totals summed over their own visible namespaces — computed from the same
    // per-namespace maps as resultNamespaces, not the (possibly truncated) slice, so
    // the aggregate stays accurate even with >30 visible namespaces.
    const clusterAggregate = scope.all
      ? {
          cpuPercent: clusterMetrics.cpu ?? 0,
          memPercent: clusterMetrics.memory ?? 0,
          totalPods: clusterMetrics.pods?.total ?? 0,
          noRequestPods: clusterNoRequestPods,
          basis: "cluster-capacity" as const,
        }
      : (() => {
          let cpuUsed = 0, cpuReq = 0, memUsed = 0, memReq = 0, podCount = 0
          for (const ns of userNs) {
            cpuUsed += cpuUsedByNs[ns.name] ?? 0
            cpuReq += cpuReqByNs[ns.name] ?? 0
            memUsed += memUsedByNs[ns.name] ?? 0
            memReq += memReqByNs[ns.name] ?? 0
            podCount += podByNs[ns.name] ?? 0
          }
          return {
            cpuPercent: cpuReq > 0 ? Math.round((cpuUsed / cpuReq) * 100) : 0,
            memPercent: memReq > 0 ? Math.round((memUsed / memReq) * 100) : 0,
            totalPods: Math.round(podCount),
            noRequestPods: clusterNoRequestPods,
            basis: "visible-requests" as const,
          }
        })()

    // scope.all: pass the raw flag through unchanged (admin already sees the whole
    // cluster, so it leaks nothing new). Scoped: only report truncation if the caller's
    // OWN visible namespaces actually came up short against Prometheus's independent
    // count — a global truncation that happened to land entirely in namespaces outside
    // their scope must stay invisible to them.
    const scopedTruncated = userNs.some(
      (ns) => (actualPodCountByNs[ns.name] ?? 0) < Math.round(podByNs[ns.name] ?? 0)
    )
    const truncated = scope.all ? allPodsResult.truncated : allPodsResult.truncated && scopedTruncated

    const response: ResourcesResponseV2 = {
      namespaces: resultNamespaces,
      topCpuPods,
      topMemPods,
      cluster: clusterAggregate,
      noRequestPodsList: noRequestPodsList.slice(0, 300),
      truncated,
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
