// TODO(wrap-up): i18n keys for ko/en — see spec §5.7
import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getArgoApps, appToCatalogService } from "@/lib/argocd"
import { evaluateAll, loadRules } from "@/lib/scorecard"

export const dynamic = "force-dynamic"

export interface ScorecardListResponse {
  evaluatedAt: string
  rulesVersion: number
  totalServices: number
  tierCounts: { gold: number; silver: number; bronze: number; none: number }
  services: Array<{
    id: string
    name: string
    namespace: string
    owner?: string
    score: number
    tier: "gold" | "silver" | "bronze" | "none"
    failedRuleIds: string[]
  }>
}

export async function GET(req: NextRequest) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  const { searchParams } = req.nextUrl
  const ownerFilter = searchParams.get("owner") ?? undefined
  const tierFilter = searchParams.get("tier") ?? undefined

  // ConfigMap 없으면 503
  let rulesVersion = 0
  try {
    const rules = await loadRules()
    rulesVersion = rules.version
  } catch (err) {
    const msg = (err as Error).message ?? ""
    const isNotFound =
      (err as NodeJS.ErrnoException).code === "NOT_FOUND" || msg.includes("404")
    if (isNotFound) {
      return NextResponse.json(
        { error: "Source unavailable", source: "configmap", message: "Scorecard rules ConfigMap not found" },
        { status: 503 },
      )
    }
    return NextResponse.json(
      { error: "Source unavailable", source: "configmap", message: msg },
      { status: 503 },
    )
  }

  try {
    const [apps, evals] = await Promise.all([
      getArgoApps(),
      evaluateAll(ownerFilter, tierFilter),
    ])

    const serviceMap = new Map(apps.map((a) => [a.metadata.name, appToCatalogService(a)]))

    const tierCounts = { gold: 0, silver: 0, bronze: 0, none: 0 }
    for (const e of evals) tierCounts[e.tier]++

    const services = evals.map((e) => {
      const svc = serviceMap.get(e.serviceId)
      return {
        id: e.serviceId,
        name: svc?.name ?? e.serviceId,
        namespace: svc?.namespace ?? "",
        owner: svc?.owner,
        score: e.score,
        tier: e.tier,
        failedRuleIds: e.failed.map((f) => f.ruleId),
      }
    })

    // Owner filter applied in-memory if evaluateAll didn't handle it
    const filtered = ownerFilter
      ? services.filter((s) => s.owner === ownerFilter)
      : services

    const response: ScorecardListResponse = {
      evaluatedAt: new Date().toISOString(),
      rulesVersion,
      totalServices: filtered.length,
      tierCounts,
      services: filtered,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error("[api/scorecards]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
