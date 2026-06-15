import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getRbacAuditList, getRbacAuditDetail } from "@/lib/compliance"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { searchParams } = new URL(req.url)
    const namespace = searchParams.get("namespace")
    const name = searchParams.get("name")

    if (namespace !== null && name !== null) {
      const detail = await getRbacAuditDetail(namespace, name)
      if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 })
      return NextResponse.json(detail)
    }

    const rows = await getRbacAuditList()
    return NextResponse.json(rows)
  } catch (err) {
    console.error("GET /api/compliance/rbac-audit error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
