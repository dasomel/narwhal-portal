import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getGroupsDetailed } from "@/lib/keycloak-client"
import { getToolsForRole, PLATFORM_TOOLS } from "@/lib/tools"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const userGroups = session.groups ?? []
  const role = session.user.role ?? "guest"

  // Base list of tools from legacy role mapping
  const roleTools = getToolsForRole(role as any)
  const allowedToolIds = new Set(roleTools.map((t) => t.id))

  try {
    // Dynamic list of tools from group attributes (mapped by UI)
    const allGroups = await getGroupsDetailed()
    const groupsWithAttributes = allGroups.filter((g) => userGroups.includes(g.name))

    for (const group of groupsWithAttributes) {
      const gAllowed = group.attributes.allowed_tools as string[] | undefined
      if (Array.isArray(gAllowed)) {
        gAllowed.forEach((id) => allowedToolIds.add(id))
      }
    }
  } catch (err) {
    console.error("Failed to fetch group attributes for dynamic tools, falling back to legacy role", err)
  }

  const finalTools = PLATFORM_TOOLS.filter((t) => allowedToolIds.has(t.id))
  return NextResponse.json(finalTools)
}
