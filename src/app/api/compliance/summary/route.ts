import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getComplianceSummary } from "@/lib/compliance"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const summary = await getComplianceSummary()
    return NextResponse.json(summary)
  } catch (err) {
    console.error("GET /api/compliance/summary error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
