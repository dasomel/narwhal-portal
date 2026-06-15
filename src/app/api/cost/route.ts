/**
 * GET /api/cost?scope=cluster|namespace|service
 *
 * spec §6.3: CostResponse
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getCost, unitPrices } from "@/lib/cost"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

const VALID_SCOPES = new Set(["cluster", "namespace", "service"])

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

    const { items, notice } = await getCost(
      scope as "cluster" | "namespace" | "service"
    )

    const body: Record<string, unknown> = {
      scope,
      generatedAt: new Date().toISOString(),
      unitPrices,
      items,
    }
    if (notice) body.notice = notice

    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[api/cost]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
