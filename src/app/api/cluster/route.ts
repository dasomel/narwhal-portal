import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export interface ClusterInfra {
  nodes: Array<{
    name: string
    status: "Ready" | "NotReady"
    roles: string[]
    cpu: { used: number | null; total: number; percent: number | null }
    memory: { usedGi: number | null; totalGi: number; percent: number | null }
    pods: { running: number; total: number }
    kubeletVersion: string
  }>
  controlPlane: Array<{
    name: string
    status: "Running" | "Pending" | "Failed"
    restarts: number
    age: string
  }>
  namespaces: Array<{
    name: string
    podCount: number
    status: "Active" | "Terminating"
  }>
  summary: {
    totalNodes: number
    readyNodes: number
    totalPods: number
    totalNamespaces: number
  }
}

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? "https://192.168.56.100:6443"
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""

async function k8sFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${K8S_API_SERVER}${path}`, {
    headers: {
      Authorization: `Bearer ${K8S_TOKEN}`,
      Accept: "application/json",
    },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`K8s API ${res.status}: ${path}`)
  return res.json() as Promise<T>
}

function parseCpuCores(cpuStr: string): number {
  if (cpuStr.endsWith("n")) return parseInt(cpuStr) / 1_000_000_000
  if (cpuStr.endsWith("m")) return parseInt(cpuStr) / 1000
  return parseFloat(cpuStr)
}

function parseMemoryGi(memStr: string): number {
  if (memStr.endsWith("Ki")) return parseInt(memStr) / (1024 * 1024)
  if (memStr.endsWith("Mi")) return parseInt(memStr) / 1024
  if (memStr.endsWith("Gi")) return parseFloat(memStr)
  return parseInt(memStr) / (1024 * 1024 * 1024)
}

function calcAge(creationTimestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(creationTimestamp).getTime()) / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cached = await cacheGet<ClusterInfra>("cluster:infra")
  if (cached) return NextResponse.json(cached)

  try {
    type NodeList = {
      items: Array<{
        metadata: { name: string; labels?: Record<string, string>; creationTimestamp: string }
        status: {
          conditions: Array<{ type: string; status: string }>
          allocatable: Record<string, string>
          nodeInfo: { kubeletVersion: string }
        }
      }>
    }

    type NodeMetricsList = {
      items: Array<{
        metadata: { name: string }
        usage: Record<string, string>
      }>
    }

    type PodList = {
      items: Array<{
        metadata: { name: string; namespace: string; creationTimestamp: string }
        spec: { nodeName?: string }
        status: {
          phase: string
          containerStatuses?: Array<{ restartCount: number }>
        }
      }>
    }

    type NamespaceList = {
      items: Array<{
        metadata: { name: string }
        status: { phase: string }
      }>
    }

    const [nodesResult, nodeMetricsResult, controlPlanePodResult, allPodsResult, namespacesResult] =
      await Promise.allSettled([
        k8sFetch<NodeList>("/api/v1/nodes"),
        k8sFetch<NodeMetricsList>("/apis/metrics.k8s.io/v1beta1/nodes"),
        k8sFetch<PodList>("/api/v1/namespaces/kube-system/pods?labelSelector=tier=control-plane"),
        k8sFetch<PodList>("/api/v1/pods"),
        k8sFetch<NamespaceList>("/api/v1/namespaces"),
      ])

    const rawNodes = nodesResult.status === "fulfilled" ? nodesResult.value.items : []
    const metricsMap = new Map<string, { cpu: string; memory: string }>()
    if (nodeMetricsResult.status === "fulfilled") {
      for (const m of nodeMetricsResult.value.items) {
        metricsMap.set(m.metadata.name, m.usage as { cpu: string; memory: string })
      }
    }

    const allPods = allPodsResult.status === "fulfilled" ? allPodsResult.value.items : []
    const podCountByNode = new Map<string, { running: number; total: number }>()
    for (const pod of allPods) {
      const node = pod.spec.nodeName ?? ""
      const cur = podCountByNode.get(node) ?? { running: 0, total: 0 }
      cur.total++
      if (pod.status.phase === "Running") cur.running++
      podCountByNode.set(node, cur)
    }

    const nodes: ClusterInfra["nodes"] = rawNodes.map((n) => {
      const isReady = n.status.conditions.some((c) => c.type === "Ready" && c.status === "True")
      const roles = Object.keys(n.metadata.labels ?? {})
        .filter((l) => l.startsWith("node-role.kubernetes.io/"))
        .map((l) => l.replace("node-role.kubernetes.io/", ""))
      if (roles.length === 0) roles.push("worker")

      const totalCpu = parseCpuCores(n.status.allocatable.cpu ?? "0")
      const totalMemGi = parseMemoryGi(n.status.allocatable.memory ?? "0")
      const usage = metricsMap.get(n.metadata.name)
      const usedCpu = usage ? parseCpuCores(usage.cpu) : null
      const usedMemGi = usage ? parseMemoryGi(usage.memory) : null

      return {
        name: n.metadata.name,
        status: isReady ? "Ready" : "NotReady",
        roles,
        cpu: {
          used: usedCpu !== null ? Math.round(usedCpu * 1000) / 1000 : null,
          total: Math.round(totalCpu * 1000) / 1000,
          percent: usedCpu !== null && totalCpu > 0 ? Math.round((usedCpu / totalCpu) * 100) : null,
        },
        memory: {
          usedGi: usedMemGi !== null ? Math.round(usedMemGi * 100) / 100 : null,
          totalGi: Math.round(totalMemGi * 100) / 100,
          percent: usedMemGi !== null && totalMemGi > 0 ? Math.round((usedMemGi / totalMemGi) * 100) : null,
        },
        pods: podCountByNode.get(n.metadata.name) ?? { running: 0, total: 0 },
        kubeletVersion: n.status.nodeInfo.kubeletVersion,
      }
    })

    const controlPlane: ClusterInfra["controlPlane"] =
      controlPlanePodResult.status === "fulfilled"
        ? controlPlanePodResult.value.items.map((p) => {
            const restarts = p.status.containerStatuses?.reduce((s, c) => s + c.restartCount, 0) ?? 0
            const phaseMap: Record<string, "Running" | "Pending" | "Failed"> = {
              Running: "Running",
              Pending: "Pending",
              Failed: "Failed",
            }
            return {
              name: p.metadata.name.replace(/-[^-]+$/, ""),
              status: phaseMap[p.status.phase] ?? "Pending",
              restarts,
              age: calcAge(p.metadata.creationTimestamp),
            }
          })
        : []

    const rawNamespaces = namespacesResult.status === "fulfilled" ? namespacesResult.value.items : []
    const podCountByNs = new Map<string, number>()
    for (const pod of allPods) {
      const ns = pod.metadata.namespace
      podCountByNs.set(ns, (podCountByNs.get(ns) ?? 0) + 1)
    }

    const namespaces: ClusterInfra["namespaces"] = rawNamespaces.map((ns) => ({
      name: ns.metadata.name,
      podCount: podCountByNs.get(ns.metadata.name) ?? 0,
      status: (ns.status.phase === "Terminating" ? "Terminating" : "Active") as "Active" | "Terminating",
    }))

    const readyNodes = nodes.filter((n) => n.status === "Ready").length
    const totalPods = allPods.length

    const result: ClusterInfra = {
      nodes,
      controlPlane,
      namespaces,
      summary: {
        totalNodes: nodes.length,
        readyNodes,
        totalPods,
        totalNamespaces: namespaces.length,
      },
    }

    await cacheSet("cluster:infra", result, 30)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[api/cluster]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
