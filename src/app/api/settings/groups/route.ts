import { NextRequest, NextResponse } from "next/server"
import { getGroupsDetailed, getUsers, addUserToGroup, removeUserFromGroup } from "@/lib/keycloak-client"
import type { KeycloakUser } from "@/lib/keycloak-client"
import { requireAdmin } from "@/lib/auth"
import { cacheGet, cacheSet, cacheDel } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export async function GET() {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const cached = await cacheGet<object[]>("api:groups-enriched")
    if (cached) return NextResponse.json(cached)

    const [groups, users] = await Promise.all([getGroupsDetailed(), getUsers()])
    const userMap = new Map<string, KeycloakUser>(users.map((u) => [u.pk, u]))
    const enriched = groups.map((g) => ({
      ...g,
      members: (g.users ?? [])
        .map((pk) => userMap.get(pk))
        .filter((u): u is KeycloakUser => !!u)
        .map((u) => ({ pk: u.pk, username: u.username, email: u.email })),
    }))
    await cacheSet("api:groups-enriched", enriched, 60)
    return NextResponse.json(enriched)
  } catch (err) {
    console.error("GET /api/settings/groups error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const { groupPk, userPk, attributes, action } = await req.json()
    if (!groupPk || !["add", "remove", "update-attributes"].includes(action)) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 })
    }
    if (action === "add") {
      if (!userPk) return NextResponse.json({ error: "userPk required" }, { status: 400 })
      await addUserToGroup(groupPk, userPk)
    } else if (action === "remove") {
      if (!userPk) return NextResponse.json({ error: "userPk required" }, { status: 400 })
      await removeUserFromGroup(groupPk, userPk)
    } else if (action === "update-attributes") {
      if (!attributes) return NextResponse.json({ error: "attributes required" }, { status: 400 })
      const { updateGroupAttributes } = await import("@/lib/keycloak-client")
      await updateGroupAttributes(groupPk, attributes)
    }
    await cacheDel("api:groups-enriched")
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("PATCH /api/settings/groups error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
