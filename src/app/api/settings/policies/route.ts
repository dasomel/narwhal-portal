import { NextResponse } from "next/server"
import { getKyvernoPolicies } from "@/lib/k8s-client"
import { requireRole } from "@/lib/auth"

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
    return NextResponse.json(await getKyvernoPolicies())
  } catch (err) {
    console.error("GET /api/settings/policies error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
