// TODO(wrap-up): i18n keys for ko/en — see spec §5.7
import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getArgoApp, appToCatalogService } from "@/lib/argocd"
import { evaluateService, loadRules } from "@/lib/scorecard"

export const dynamic = "force-dynamic"

export interface ScorecardDetailResponse {
  service: { id: string; name: string; namespace: string; owner?: string }
  score: number
  tier: "gold" | "silver" | "bronze" | "none"
  evaluatedAt: string
  rules: Array<{
    id: string
    name: string
    description: string
    weight: number
    status: "pass" | "fail"
    failReason?: string
    actionUrl?: string
  }>
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ svc: string }> },
) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  const { svc } = await params

  // ConfigMap 없으면 503
  let rulesDoc
  try {
    rulesDoc = await loadRules()
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
    const [app, evaluation] = await Promise.all([
      getArgoApp(svc),
      evaluateService(svc),
    ])

    if (!app) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 })
    }

    const catalogSvc = appToCatalogService(app)

    // Build ruleMap for name + ArgoCD deep link
    const ruleMap = new Map(rulesDoc.rules.map((r) => [r.id, r]))
    const argocdUrl = process.env.ARGOCD_URL ?? ""

    const passedIds = new Set(evaluation.passed.map((p) => p.ruleId))
    const failedMap = new Map(evaluation.failed.map((f) => [f.ruleId, f.reason]))

    const rules = rulesDoc.rules.map((rule) => {
      const pass = passedIds.has(rule.id)
      const failReason = failedMap.get(rule.id)

      let actionUrl: string | undefined
      if (!pass) {
        const check = rule.check
        if (check.type === "argocd-status" || check.type === "argocd-history") {
          actionUrl = `${argocdUrl}/applications/${svc}`
        } else if (catalogSvc.runbookUrl) {
          actionUrl = catalogSvc.runbookUrl
        }
      }

      return {
        id: rule.id,
        name: rule.name,
        description: ruleMap.get(rule.id)?.name ?? rule.id,
        weight: rule.weight,
        status: (pass ? "pass" : "fail") as "pass" | "fail",
        ...(failReason ? { failReason } : {}),
        ...(actionUrl ? { actionUrl } : {}),
      }
    })

    const response: ScorecardDetailResponse = {
      service: {
        id: svc,
        name: catalogSvc.name,
        namespace: catalogSvc.namespace,
        owner: catalogSvc.owner,
      },
      score: evaluation.score,
      tier: evaluation.tier,
      evaluatedAt: evaluation.evaluatedAt,
      rules,
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = (err as Error).message ?? ""
    if (msg.includes("not found")) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 })
    }
    console.error("[api/scorecards/[svc]]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
