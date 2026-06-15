import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getComplianceFrameworks, getComplianceFrameworkDetail } from "@/lib/compliance"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

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
