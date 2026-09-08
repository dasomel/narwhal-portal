/**
 * GET /api/cost/trend?scope=cluster|namespace|service&id=&days=N
 *
 * spec §6.3: CostTrendResponse
 * days 최대 90, 초과 시 400 ValidationError
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { CostPricingConfigurationError, getCostPricing, getCostTrend } from "@/lib/cost"
import { getArgoApp } from "@/lib/argocd"
import { appVisible, getEffectiveScope, namespaceVisible } from "@/lib/scope"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

const VALID_SCOPES = new Set(["cluster", "namespace", "service"])
const MAX_DAYS = 90

export interface CostTrendResponse {
  scope: "cluster" | "namespace" | "service"
  id: string
  days: number
  generatedAt: string
  pricing: ReturnType<typeof getCostPricing>["metadata"]
  points: Awaited<ReturnType<typeof getCostTrend>>["points"]
  notice?: string
}

export async function GET(req: NextRequest) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    const scope = req.nextUrl.searchParams.get("scope") ?? "cluster"
    if (!VALID_SCOPES.has(scope)) {
      throw new ValidationError(
        `invalid scope: must be one of cluster, namespace, service`,
        "scope"
      )
    }

    const id = req.nextUrl.searchParams.get("id") ?? scope
    if (!id || id.length > 253) {
      throw new ValidationError("invalid id: must be a non-empty string (≤253 chars)", "id")
    }

    const daysParam = req.nextUrl.searchParams.get("days") ?? "30"
    const days = parseInt(daysParam, 10)
    if (isNaN(days) || days < 1) {
      throw new ValidationError("invalid days: must be a positive integer", "days")
    }
    if (days > MAX_DAYS) {
      throw new ValidationError(`invalid days: maximum is ${MAX_DAYS}`, "days")
    }

    // portal#61: id was passed straight to Prometheus with no ownership check — a
    // caller with a valid role but out-of-scope id could read another team's
    // namespace/service cost trend. namespace scope checks the id directly;
    // service scope resolves it through ArgoCD the same way cost/[svc] and
    // scorecards/[svc] do. cluster scope is restricted to visible namespaces inside
    // getCostTrend itself (a non-admin has no single id to deny on).
    const effScope = await getEffectiveScope(gate.session)
    if (scope === "namespace" && !namespaceVisible(id, effScope)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (scope === "service") {
      const app = await getArgoApp(id)
      if (!app) {
        return NextResponse.json({ error: "Service not found" }, { status: 404 })
      }
      if (!appVisible(app.spec.project ?? "default", app.spec.destination?.namespace ?? app.metadata.namespace ?? "default", effScope)) {
        return NextResponse.json({ error: "Service not found" }, { status: 404 })
      }
    }

    const pricing = getCostPricing()
    const { points, notice } = await getCostTrend(
      scope as "cluster" | "namespace" | "service",
      id,
      days,
      effScope
    )

    const body: CostTrendResponse = {
      scope: scope as CostTrendResponse["scope"],
      id,
      days,
      generatedAt: new Date().toISOString(),
      pricing: pricing.metadata,
      points,
    }
    if (notice) body.notice = notice

    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof CostPricingConfigurationError) {
      return NextResponse.json(
        { error: "Cost pricing is not configured", invalid: err.invalid },
        { status: 503 }
      )
    }
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[api/cost/trend]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
