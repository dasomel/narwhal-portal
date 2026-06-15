import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoAppsOrThrow } from "@/lib/argocd"
import { getAlerts } from "@/lib/alertmanager"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export interface ScorecardItem {
  service: string
  namespace: string
  scores: {
    gitops: number
    health: number
    alerting: number
    resources: number
    overall: number
  }
  details: string[]
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cacheKey = "governance:scorecard"
  const cached = await cacheGet<ScorecardItem[]>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const [apps, alerts] = await Promise.all([getArgoAppsOrThrow(), getAlerts()])

    const scorecards: ScorecardItem[] = apps.map((app) => {
      const details: string[] = []
      let gitops = 0
      let health = 0
      let alerting = 100
      let resources = 0

      // GitOps score
      if (app.status.sync.status === "Synced") { gitops = 100 } else { gitops = 30; details.push("OutOfSync") }

      // Health score
      if (app.status.health.status === "Healthy") { health = 100 }
      else if (app.status.health.status === "Progressing") { health = 70; details.push("Progressing") }
      else { health = 0; details.push(`Health: ${app.status.health.status}`) }

      // Alert score (penalize for related alerts)
      const relatedAlerts = alerts.filter((a) => a.labels.namespace === app.spec.destination?.namespace)
      if (relatedAlerts.length > 0) {
        alerting = Math.max(0, 100 - relatedAlerts.length * 25)
        details.push(`${relatedAlerts.length} active alert(s)`)
      }

      // Resource score (has resources defined)
      const resCount = app.status.resources?.length ?? 0
      resources = resCount > 0 ? Math.min(100, resCount * 10) : 0

      const overall = Math.round((gitops + health + alerting + resources) / 4)

      return {
        service: app.metadata.name,
        namespace: app.spec.destination?.namespace ?? "default",
        scores: { gitops, health, alerting, resources, overall },
        details,
      }
    })

    scorecards.sort((a, b) => a.scores.overall - b.scores.overall)
    await cacheSet(cacheKey, scorecards, 30)
    return NextResponse.json(scorecards)
  } catch (err) {
    console.error("[governance/scorecard]", err)
    return NextResponse.json({ error: "ArgoCD connection failed" }, { status: 503 })
  }
}
