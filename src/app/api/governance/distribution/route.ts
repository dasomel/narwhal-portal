import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { getNodeMetrics } from "@/lib/prometheus"
import {
  getAllNodesForDistribution,
  getAllPodsForDistribution,
} from "@/lib/k8s-client"
import type { DistributionRecommendation, ControlPlanePod } from "@/components/governance/types"
export type { DistributionRecommendation, ControlPlanePod } from "@/components/governance/types"
import { buildDistributionRecommendations, CONTROL_PLANE_POD_LIST_CAP } from "@/lib/governance/distribution"

export const dynamic = "force-dynamic"

export interface NodeLoad {
  node: string
  role: "control-plane" | "worker"
  podCount: number
  cpuPercent: number | null
  memPercent: number | null
}

export interface WorkloadSpread {
  namespace: string
  kind: string
  name: string
  replicas: number
  nodes: { node: string; count: number }[]
  distinctNodes: number
  concentrated: boolean
  hasAntiAffinity: boolean
  hasTopologySpread: boolean
  risk: "high" | "medium" | "low"
}

export interface DistributionSummary {
  nodeCount: number
  workerCount: number
  totalPods: number
  podImbalance: number
  maxNode: { node: string; podCount: number } | null
  minNode: { node: string; podCount: number } | null
  concentratedWorkloads: number
  unguardedWorkloads: number
  multiReplicaWorkloads: number
  controlPlaneWorkloadPods: number
}


export interface DistributionResponse {
  summary: DistributionSummary
  nodes: NodeLoad[]
  workloads: WorkloadSpread[]
  recommendations: DistributionRecommendation[]
  controlPlanePods: ControlPlanePod[]
}

export async function GET() {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const cacheKey = "governance:distribution:v2"
  try {
    const cached = await cacheGet<DistributionResponse>(cacheKey)
    if (cached) return NextResponse.json(cached)
  } catch (err) {
    console.warn("[governance/distribution] Cache read failed (non-fatal):", err)
  }

  try {
    const [nodes, pods, promMetrics] = await Promise.all([
      getAllNodesForDistribution(),
      getAllPodsForDistribution(),
      getNodeMetrics().catch((err) => {
        console.warn("[governance/distribution] Prometheus getNodeMetrics failed (non-fatal):", err)
        return []
      }),
    ])

    const controlPlaneNodes = new Set<string>()
    const workerNodesList: string[] = []

    for (const node of nodes) {
      const name = node.metadata.name
      const labels = node.metadata.labels ?? {}
      if ("node-role.kubernetes.io/control-plane" in labels) {
        controlPlaneNodes.add(name)
      } else {
        workerNodesList.push(name)
      }
    }

    const nodePodCounts: Record<string, number> = {}
    for (const node of nodes) {
      nodePodCounts[node.metadata.name] = 0
    }

    const workloadsMap = new Map<string, {
      namespace: string
      kind: string
      name: string
      replicas: number
      nodeCounts: Record<string, number>
      hasAntiAffinity: boolean
      hasTopologySpread: boolean
    }>()

    let controlPlaneWorkloadPods = 0
    let totalPodsCount = 0
    const controlPlanePods: ControlPlanePod[] = []

    for (const pod of pods) {
      const nodeName = pod.spec?.nodeName
      if (!nodeName) continue

      totalPodsCount++
      nodePodCounts[nodeName] = (nodePodCounts[nodeName] || 0) + 1

      const owner = pod.metadata.ownerReferences?.[0]

      // 스태틱 파드(ownerRef kind=Node: kube-apiserver/etcd/scheduler/kube-vip 등)는
      // 설계상 노드당 1개로 고정 — 분산 대상 워크로드가 아니므로 집계에서 제외
      if (owner?.kind === "Node") continue

      let kind = "Pod"
      let name = pod.metadata.name

      if (owner) {
        if (owner.kind === "ReplicaSet") {
          kind = "Deployment"
          name = owner.name.replace(/-[a-f0-9]{8,10}$/, "")
        } else {
          kind = owner.kind
          name = owner.name
        }
      }

      if (controlPlaneNodes.has(nodeName)) {
        const ownerKind = owner?.kind
        if (ownerKind === "Deployment" || ownerKind === "StatefulSet" || ownerKind === "ReplicaSet") {
          controlPlaneWorkloadPods++
          if (controlPlanePods.length < CONTROL_PLANE_POD_LIST_CAP) {
            controlPlanePods.push({
              namespace: pod.metadata.namespace,
              pod: pod.metadata.name,
              workload: name,
              kind,
              node: nodeName,
            })
          }
        }
      }

      const key = `${pod.metadata.namespace}/${kind}/${name}`
      let workload = workloadsMap.get(key)
      if (!workload) {
        workload = {
          namespace: pod.metadata.namespace,
          kind,
          name,
          replicas: 0,
          nodeCounts: {},
          hasAntiAffinity: false,
          hasTopologySpread: false,
        }
        workloadsMap.set(key, workload)
      }

      workload.replicas++
      workload.nodeCounts[nodeName] = (workload.nodeCounts[nodeName] || 0) + 1
      if (pod.spec?.affinity?.podAntiAffinity) {
        workload.hasAntiAffinity = true
      }
      if (pod.spec?.topologySpreadConstraints && pod.spec.topologySpreadConstraints.length > 0) {
        workload.hasTopologySpread = true
      }
    }

    const workloads: WorkloadSpread[] = []
    let concentratedWorkloads = 0
    let unguardedWorkloads = 0
    let multiReplicaWorkloads = 0

    for (const wl of workloadsMap.values()) {
      const nodesSpread = Object.entries(wl.nodeCounts).map(([node, count]) => ({
        node,
        count,
      })).sort((a, b) => b.count - a.count)

      const distinctNodes = nodesSpread.length
      // DaemonSet은 노드당 1개가 정상 동작 — anti-affinity/spread 개념이 무의미하므로
      // 집중/미보장 판정에서 제외(항상 low)
      const isDaemonSet = wl.kind === "DaemonSet"
      const concentrated = !isDaemonSet && wl.replicas >= 2 && distinctNodes === 1

      let risk: "high" | "medium" | "low" = "low"
      if (concentrated) {
        risk = "high"
      } else if (!isDaemonSet && wl.replicas >= 2 && !wl.hasAntiAffinity && !wl.hasTopologySpread) {
        risk = "medium"
      }

      if (risk === "high") concentratedWorkloads++
      if (risk === "medium") unguardedWorkloads++
      if (wl.replicas >= 2) multiReplicaWorkloads++

      workloads.push({
        namespace: wl.namespace,
        kind: wl.kind,
        name: wl.name,
        replicas: wl.replicas,
        nodes: nodesSpread,
        distinctNodes,
        concentrated,
        hasAntiAffinity: wl.hasAntiAffinity,
        hasTopologySpread: wl.hasTopologySpread,
        risk,
      })
    }

    const riskScores = { high: 3, medium: 2, low: 1 }
    workloads.sort((a, b) => {
      const rDiff = riskScores[b.risk] - riskScores[a.risk]
      if (rDiff !== 0) return rDiff
      return b.replicas - a.replicas
    })
    const finalWorkloads = workloads.slice(0, 200)

    const finalNodes: NodeLoad[] = nodes.map((node) => {
      const name = node.metadata.name
      const role = controlPlaneNodes.has(name) ? "control-plane" : "worker"
      const podCount = nodePodCounts[name] ?? 0

      const metric = promMetrics.find((m) => m.node === name)
      const cpuPercent = metric ? metric.cpu.usagePercent : null
      const memPercent = metric ? metric.memory.usagePercent : null

      return {
        node: name,
        role,
        podCount,
        cpuPercent,
        memPercent,
      }
    })

    const workerNodes = finalNodes.filter((n) => n.role === "worker").sort((a, b) => b.podCount - a.podCount)
    const controlPlaneNodesList = finalNodes.filter((n) => n.role === "control-plane").sort((a, b) => b.podCount - a.podCount)
    const sortedNodes = [...workerNodes, ...controlPlaneNodesList]

    let podImbalance = 0
    let maxNode: { node: string; podCount: number } | null = null
    let minNode: { node: string; podCount: number } | null = null

    if (workerNodes.length > 0) {
      const maxWorker = workerNodes[0]
      const minWorker = workerNodes[workerNodes.length - 1]
      podImbalance = maxWorker.podCount - minWorker.podCount
      maxNode = { node: maxWorker.node, podCount: maxWorker.podCount }
      minNode = { node: minWorker.node, podCount: minWorker.podCount }
    }

    const summary: DistributionSummary = {
      nodeCount: nodes.length,
      workerCount: workerNodes.length,
      totalPods: totalPodsCount,
      podImbalance,
      maxNode,
      minNode,
      concentratedWorkloads,
      unguardedWorkloads,
      multiReplicaWorkloads,
      controlPlaneWorkloadPods,
    }

    const recommendations = buildDistributionRecommendations(summary)

    const response: DistributionResponse = {
      summary,
      nodes: sortedNodes,
      workloads: finalWorkloads,
      recommendations,
      controlPlanePods,
    }

    try {
      await cacheSet(cacheKey, response, 15)
    } catch (err) {
      console.warn("[governance/distribution] Cache write failed (non-fatal):", err)
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error("[governance/distribution] Error handling GET:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
