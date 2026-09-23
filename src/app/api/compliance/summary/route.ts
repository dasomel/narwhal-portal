import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getComplianceSummary } from "@/lib/compliance"

export const dynamic = "force-dynamic"

export async function GET() {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    const summary = await getComplianceSummary()
    return NextResponse.json(summary)
  } catch (err) {
    console.error("GET /api/compliance/summary error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
