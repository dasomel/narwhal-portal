import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getComplianceFrameworks, getComplianceFrameworkDetail } from "@/lib/compliance"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (id !== null) {
      const detail = await getComplianceFrameworkDetail(id)
      if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 })
      return NextResponse.json(detail)
    }

    const frameworks = await getComplianceFrameworks()
    return NextResponse.json(frameworks)
  } catch (err) {
    console.error("GET /api/compliance/frameworks error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
