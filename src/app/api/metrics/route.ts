import { NextResponse } from "next/server"
import { getClusterMetrics, getNodeMetrics } from "@/lib/prometheus"
import { auth } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const [metrics, nodeMetrics] = await Promise.all([
      getClusterMetrics(),
      getNodeMetrics(),
    ])
    return NextResponse.json({ ...metrics, nodeMetrics })
  } catch (err) {
    console.error("[api/metrics]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
