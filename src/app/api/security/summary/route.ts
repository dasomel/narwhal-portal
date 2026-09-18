import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getSecuritySummary } from "@/lib/trivy"

export const dynamic = "force-dynamic"

export async function GET(_req: Request) {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    return NextResponse.json(await getSecuritySummary())
  } catch (err) {
    console.error("GET /api/security/summary error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
