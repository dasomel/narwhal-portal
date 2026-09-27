import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getDependencyHealthSummary } from "@/lib/dependency-health"

export const dynamic = "force-dynamic"

const AUTHENTICATED_ROLES = ["cluster-admin", "developer", "viewer", "guest"] as const

export async function GET() {
  const gate = await requireRole(...AUTHENTICATED_ROLES)
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  return NextResponse.json(await getDependencyHealthSummary())
}
