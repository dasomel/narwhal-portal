import { NextResponse } from "next/server"
import { getToolsForRole } from "@/lib/tools"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { auth } from "@/lib/auth"
import type { UserRole } from "@/lib/auth"

export const dynamic = "force-dynamic"

async function checkHealth(url: string): Promise<"healthy" | "degraded" | "offline"> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" })
    clearTimeout(timeout)
    return res.status < 500 ? "healthy" : "degraded"
  } catch {
    return "offline"
  }
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const role = session.user.role
  const cacheKey = `tools:health:${role}`

  const cached = await cacheGet<Record<string, string>>(cacheKey)
  if (cached) return NextResponse.json(cached)

  const tools = getToolsForRole(role)
  const results = await Promise.all(
    tools.map(async (tool) => [tool.id, await checkHealth(tool.url)])
  )
  const health = Object.fromEntries(results)
  await cacheSet(cacheKey, health, 30)
  return NextResponse.json(health)
}
