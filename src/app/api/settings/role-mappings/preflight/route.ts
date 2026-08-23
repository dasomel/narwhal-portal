import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth"
import { getNamespaces } from "@/lib/k8s-client"
import { findOrphanedNamespacePatterns } from "@/lib/role-filter"

export const dynamic = "force-dynamic"

export interface RoleMappingPreflightResponse {
  checkedAt: string
  orphanedNamespacePatterns: { group: string; pattern: string }[]
}

// portal#45: admin-only diagnostic for config/role-filter.json drift — see
// findOrphanedNamespacePatterns for what "orphaned" means and its current scope
// (namespace patterns only, not argocdProjects).
export async function GET() {
  const gate = await requireAdmin()
  if ("error" in gate) {
    const status = gate.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }

  try {
    const namespaces = await getNamespaces()
    const orphanedNamespacePatterns = findOrphanedNamespacePatterns(namespaces)
    const response: RoleMappingPreflightResponse = {
      checkedAt: new Date().toISOString(),
      orphanedNamespacePatterns,
    }
    return NextResponse.json(response)
  } catch (err) {
    console.error("[api/settings/role-mappings/preflight]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
