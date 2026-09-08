/**
 * GET /api/cost?scope=cluster|namespace|service
 *
 * spec §6.3: CostResponse
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { CostPricingConfigurationError, getCost, getCostPricing } from "@/lib/cost"
import { getEffectiveScope } from "@/lib/scope"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

const VALID_SCOPES = new Set(["cluster", "namespace", "service"])

export interface CostResponse {
  scope: "cluster" | "namespace" | "service"
  generatedAt: string
  unitPrices: ReturnType<typeof getCostPricing>["unitPrices"]
  pricing: ReturnType<typeof getCostPricing>["metadata"]
  items: Awaited<ReturnType<typeof getCost>>["items"]
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

    // portal#28: getCost previously returned every namespace/service's cost to any
    // developer/viewer regardless of team ownership — filter to the same
    // effective scope the other scoped routes apply, before any aggregation happens.
    const effScope = await getEffectiveScope(gate.session)
    const pricing = getCostPricing()
    const { items, notice } = await getCost(
      scope as "cluster" | "namespace" | "service",
      effScope
    )

    const body: CostResponse = {
      scope: scope as CostResponse["scope"],
      generatedAt: new Date().toISOString(),
      unitPrices: pricing.unitPrices,
      pricing: pricing.metadata,
      items,
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
    console.error("[api/cost]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
