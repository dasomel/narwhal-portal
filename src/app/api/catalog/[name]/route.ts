import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApp } from "@/lib/argocd"
import { getAlerts } from "@/lib/alertmanager"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { name } = await params

  try {
    const [app, alerts] = await Promise.all([getArgoApp(name), getAlerts()])

    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const relatedAlerts = alerts.filter(
      (a) =>
        a.labels.namespace === app.spec.destination?.namespace ||
        a.labels.app === name
    )

    return NextResponse.json({
      app,
      alerts: relatedAlerts,
    })
  } catch (err) {
    console.error("[api/catalog/detail]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
