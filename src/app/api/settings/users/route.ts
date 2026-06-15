import { NextRequest, NextResponse } from "next/server"
import { getUsers, createUser } from "@/lib/keycloak-client"
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
    const cached = await cacheGet<any[]>("api:users-list")
    if (cached) return NextResponse.json(cached)

    const users = await getUsers()
    await cacheSet("api:users-list", users, 60)
    return NextResponse.json(users)
  } catch (err) {
    console.error("GET /api/settings/users error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const body = await req.json()
    const { username, email } = body
    if (!username || typeof username !== "string" || !email || typeof email !== "string") {
      return NextResponse.json({ error: "Invalid input: username and email are required" }, { status: 400 })
    }
    return NextResponse.json(await createUser(body), { status: 201 })
  } catch (err) {
    console.error("POST /api/settings/users error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
