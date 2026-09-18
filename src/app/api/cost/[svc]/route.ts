/**
 * GET /api/cost/[svc]
 *
 * spec §6.3: CostDetailResponse — service 단일 비용 + top 5 pods
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getCostByService, unitPrices } from "@/lib/cost"
import { getArgoApp } from "@/lib/argocd"
import { appVisible, getEffectiveScope } from "@/lib/scope"
import { ValidationError, toValidationErrorBody, K8S_NAME_RE } from "@/lib/validation"

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
    const app = await getArgoApp(svc)
    if (!app) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 })
    }
    const scope = await getEffectiveScope(gate.session)
    if (!appVisible(app.spec.project ?? "default", app.spec.destination?.namespace ?? app.metadata.namespace ?? "default", scope)) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 })
    }

    const result = await getCostByService(svc)

    if ("notice" in result && !("serviceId" in result)) {
      // Prometheus 미응답 — 200 + notice (graceful degradation)
      return NextResponse.json({
        serviceId: svc,
        generatedAt: new Date().toISOString(),
        unitPrices,
        items: [],
        notice: result.notice,
      })
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      unitPrices,
      ...result,
    })
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[api/cost/[svc]]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
