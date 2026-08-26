import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoAppsOrThrow } from "@/lib/argocd"
import { getAlerts } from "@/lib/alertmanager"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { appVisible, getEffectiveScope } from "@/lib/scope"
import { findOwnershipMismatch, getTeamMappings, type OwnershipMismatch } from "@/lib/role-filter"

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
  // portal#31 AC: flag (not deny) when this app's declared ArgoCD project and its
  // actual destination namespace are owned by different teams per
  // role-filter.json — null when they agree or neither is mapped.
  ownershipMismatch: OwnershipMismatch | null
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // portal#31: this held a fully-rendered, unfiltered result under one literal cache
  // key — the same class of bug the 2026-08-20 events:timeline fix already
  // documented: caching a scope-filtered response under a single key leaks the
  // first requester's (or here, an entirely unfiltered) result to everyone after.
  // Scoping the key, not just the response, is what makes this safe to cache at all.
  const scope = await getEffectiveScope(session)
  const cacheKey = `governance:scorecard:${scope.fingerprint}`
  const cached = await cacheGet<ScorecardItem[]>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const [allApps, alerts] = await Promise.all([getArgoAppsOrThrow(), getAlerts()])
    const apps = allApps.filter((app) =>
      appVisible(app.spec.project ?? "default", app.spec.destination?.namespace ?? app.metadata.namespace ?? "default", scope),
    )
    const teamMappings = getTeamMappings()

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

      // Alert score (penalize for related alerts).
      // Exclude non-actionable meta-alerts: Watchdog (heartbeat) and InfoInhibitor
      // (severity=none inhibition source) always fire by design in kube-prometheus-stack
      // and are NOT real problems. They carry a namespace label, so counting them flagged
      // every app sharing that namespace (e.g. all `storage`-ns apps: openbao, seaweedfs,
      // velero, velero-ui) with a phantom "1 active alert".
      const relatedAlerts = alerts.filter(
        (a) =>
          a.labels.namespace === app.spec.destination?.namespace &&
          a.labels.severity !== "none" &&
          a.labels.alertname !== "Watchdog" &&
          a.labels.alertname !== "InfoInhibitor",
      )
      if (relatedAlerts.length > 0) {
        alerting = Math.max(0, 100 - relatedAlerts.length * 25)
        details.push(`${relatedAlerts.length} active alert(s)`)
      }

      // Resource score (has resources defined)
      const resCount = app.status.resources?.length ?? 0
      resources = resCount > 0 ? Math.min(100, resCount * 10) : 0

      const overall = Math.round((gitops + health + alerting + resources) / 4)

      const project = app.spec.project ?? "default"
      const namespace = app.spec.destination?.namespace ?? "default"

      return {
        service: app.metadata.name,
        namespace,
        scores: { gitops, health, alerting, resources, overall },
        details,
        ownershipMismatch: findOwnershipMismatch(project, namespace, teamMappings),
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
