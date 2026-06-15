import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps, appToCatalogService } from "@/lib/argocd"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const apps = await getArgoApps()
    const services = apps.map(appToCatalogService)
    return NextResponse.json(services)
  } catch (err) {
    console.error("[api/catalog]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
