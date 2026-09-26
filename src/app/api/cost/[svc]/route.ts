/**
 * GET /api/cost/[svc]
 *
 * spec §6.3: CostDetailResponse — service 단일 비용 + top 5 pods
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getArgoApp } from "@/lib/argocd"
import { CostPricingConfigurationError, getCostByService, getCostPricing } from "@/lib/cost"
import { appVisible, getEffectiveScope } from "@/lib/scope"
import { ValidationError, toValidationErrorBody, K8S_NAME_RE, K8S_NAMESPACE_RE } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ svc: string }> }
) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  try {
    const { svc } = await params
    if (!svc || typeof svc !== "string" || svc.length > 253 || !K8S_NAME_RE.test(svc)) {
      throw new ValidationError("invalid svc: must match RFC 1123 label", "svc")
    }

    // portal#61: same by-name scope bypass as /api/catalog/[name] and
    // /api/scorecards/[svc] — a guessed/known service id previously returned full
    // cost + top-pod detail regardless of team ownership. Resolve the ArgoCD app the
    // same way scorecards/[svc] does and require it be within the caller's scope.
    // The resolved namespace is validated (defense against a malformed value reaching
    // the PromQL query) and passed into getCostByService so the query itself is
    // pinned to it — a duplicate service label in another team's namespace can't
    // leak through.
    const app = await getArgoApp(svc)
    const namespace = app?.spec.destination?.namespace ?? "default"
    if (!K8S_NAMESPACE_RE.test(namespace)) {
      throw new ValidationError("invalid service destination namespace: must match RFC 1123 label", "namespace")
    }
    const effScope = await getEffectiveScope(gate.session)
    if (!app || !appVisible(app.spec.project ?? "default", namespace, effScope)) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 })
    }

    const pricing = getCostPricing()
    const result = await getCostByService(svc, effScope, namespace)

    if ("notice" in result && !("serviceId" in result)) {
      // Prometheus 미응답 — 200 + notice + telemetry.state="unavailable"
      // (graceful degradation, portal#64 AC4)
      return NextResponse.json({
        serviceId: svc,
        generatedAt: new Date().toISOString(),
        unitPrices: pricing.unitPrices,
        pricing: pricing.metadata,
        items: [],
        notice: result.notice,
        telemetry: result.telemetry,
      })
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      unitPrices: pricing.unitPrices,
      pricing: pricing.metadata,
      ...result,
    })
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
    console.error("[api/cost/[svc]]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
