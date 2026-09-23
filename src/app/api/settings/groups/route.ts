import { NextRequest, NextResponse } from "next/server"
import {
  getGroupsDetailed,
  getUsers,
  addUserToGroup,
  removeUserFromGroup,
  updateGroupAttributes,
  KEYCLOAK_CACHE_KEYS,
} from "@/lib/keycloak-client"
import type { KeycloakUser } from "@/lib/keycloak-client"
import { requireAdmin } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export async function GET() {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const cached = await cacheGet<object[]>(KEYCLOAK_CACHE_KEYS.groupsEnriched)
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
    // Portal #49: getGroupsDetailed() marks a group membersPartial when its
    // member fetch failed. Never cache that projection as complete — the
    // next caller must re-fetch instead of being served dropped memberships
    // for the TTL window.
    const anyPartial = enriched.some((g) => g.membersPartial)
    if (!anyPartial) {
      await cacheSet(KEYCLOAK_CACHE_KEYS.groupsEnriched, enriched, 60)
    }
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
      await updateGroupAttributes(groupPk, attributes)
    }
    // Portal #49: each keycloak-client mutation above already invalidates
    // KEYCLOAK_CACHE_KEYS.groupsEnriched itself — keep invalidation
    // single-owner there instead of duplicating it in this route.
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("PATCH /api/settings/groups error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
