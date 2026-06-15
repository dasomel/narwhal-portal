import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getNodeDetail } from "@/lib/k8s-client"
import { getNodeMetrics, getNodePodCount } from "@/lib/prometheus"
import { assertK8sNodeName, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { name } = await params
  try {
    assertK8sNodeName(name)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }

  const [detail, nodeMetrics, podCount] = await Promise.allSettled([
    getNodeDetail(name),
    getNodeMetrics(),
    getNodePodCount(name),
  ])

  if (detail.status === "rejected" || !detail.value) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 })
  }

  const metrics = nodeMetrics.status === "fulfilled"
    ? nodeMetrics.value.find((n) => n.node === name)
    : null

  return NextResponse.json({
    ...detail.value,
    cpu: metrics?.cpu ?? { cores: 0, usagePercent: 0 },
    memory: metrics?.memory ?? { totalBytes: 0, usagePercent: 0 },
    disk: metrics?.disk ?? { totalBytes: 0, usagePercent: 0 },
    podCount: podCount.status === "fulfilled" ? podCount.value : 0,
  })
}
