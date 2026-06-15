import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { queryRange } from "@/lib/prometheus"
import { assertK8sNodeName, ValidationError } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const metric = searchParams.get("metric") ?? "cpu"
  const minutesRaw = Number(searchParams.get("minutes") ?? "60")
  if (!Number.isFinite(minutesRaw) || minutesRaw <= 0) {
    return NextResponse.json(
      { error: "ValidationError", message: "minutes must be a positive number", field: "minutes" },
      { status: 400 },
    )
  }
  const minutes = Math.min(minutesRaw, 1440)
  const node = searchParams.get("node")

  if (node) {
    try {
      assertK8sNodeName(node)
    } catch (err) {
      if (err instanceof ValidationError) {
        return NextResponse.json({ error: "ValidationError", message: err.message, field: err.field }, { status: 400 })
      }
      throw err
    }
  }

  let promql = ""
  if (node) {
    // node_exporter uses instance=IP:9100; join via kube_node_info{node=...} → internal_ip → instance
    const nodeJoin = `* on(instance) group_left() label_replace(kube_node_info{node="${node}"}, "instance", "$1:9100", "internal_ip", "(.+)")`
    const ALLOWED_NODE_QUERIES: Record<string, string> = {
      cpu: `100 - (avg by(instance)(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) ${nodeJoin}`,
      memory: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 ${nodeJoin}`,
      disk: `(1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",mountpoint="/"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay",mountpoint="/"}) * 100 ${nodeJoin}`,
      pods: `count(kube_pod_info{node="${node}"})`,
      network: `(sum by(instance)(irate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m])) + sum by(instance)(irate(node_network_transmit_bytes_total{device!~"lo|veth.*"}[5m]))) / 1024 / 1024 ${nodeJoin}`,
    }
    promql = ALLOWED_NODE_QUERIES[metric]
  } else {
    const ALLOWED_QUERIES: Record<string, string> = {
      cpu: '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
      memory: '(1 - (sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))) * 100',
      pods: 'count(kube_pod_status_phase{phase="Running"})',
      network: '(sum(irate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m])) + sum(irate(node_network_transmit_bytes_total{device!~"lo|veth.*"}[5m]))) / 1024 / 1024',
    }
    promql = ALLOWED_QUERIES[metric]
  }

  if (!promql) return NextResponse.json({ error: "Invalid metric" }, { status: 400 })

  try {
    const data = await queryRange(promql, minutes)
    return NextResponse.json({ metric, data })
  } catch (err) {
    console.error("[api/metrics/range]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
