import { NextRequest, NextResponse } from "next/server"
import { getRoutes, toggleRoute } from "@/lib/apisix-client"
import { requireAdmin } from "@/lib/auth"
import { cacheGet, cacheSet, cacheDel } from "@/lib/valkey"
import { cacheKeys, cacheTtl } from "@/lib/cache-keys"

export const dynamic = "force-dynamic"

export async function GET() {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const cached = await cacheGet<any[]>(cacheKeys.routesList())
    if (cached) return NextResponse.json(cached)

    const routes = await getRoutes()
    await cacheSet(cacheKeys.routesList(), routes, cacheTtl("routesList"))
    return NextResponse.json(routes)
  }
  catch (err) {
    console.error("GET /api/settings/routes error:", err)
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
    const { id, enable } = await req.json()
    if (!id || typeof id !== "string" || typeof enable !== "boolean") {
      return NextResponse.json({ error: "Invalid input: id (string) and enable (boolean) required" }, { status: 400 })
    }
    await toggleRoute(id, enable)
    await cacheDel(cacheKeys.routesList())
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("PATCH /api/settings/routes error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
