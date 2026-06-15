import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getSecuritySummary } from "@/lib/trivy"

export const dynamic = "force-dynamic"

export async function GET(_req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    return NextResponse.json(await getSecuritySummary())
  } catch (err) {
    console.error("GET /api/security/summary error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
