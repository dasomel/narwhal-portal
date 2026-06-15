/**
 * GET /api/cost/trend?scope=cluster|namespace|service&id=&days=N
 *
 * spec §6.3: CostTrendResponse
 * days 최대 90, 초과 시 400 ValidationError
 * RBAC: cluster-admin | developer | viewer
 */

import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getCostTrend } from "@/lib/cost"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

const VALID_SCOPES = new Set(["cluster", "namespace", "service"])
const MAX_DAYS = 90

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

    const { points, notice } = await getCostTrend(
      scope as "cluster" | "namespace" | "service",
      id,
      days
    )

    const body: Record<string, unknown> = {
      scope,
      id,
      days,
      generatedAt: new Date().toISOString(),
      points,
    }
    if (notice) body.notice = notice

    return NextResponse.json(body)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[api/cost/trend]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
