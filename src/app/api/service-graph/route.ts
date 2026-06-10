import { NextRequest, NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getServiceGraph, isAllowedWindow } from "@/lib/service-graph"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export interface ServiceGraphResponse {
  window: string
  generatedAt: string
  nodes: Array<{
    id: string
    namespace: string
    status: "healthy" | "degraded" | "unknown"
    scoreTier?: "gold" | "silver" | "bronze" | "none"
  }>
  edges: Array<{
    source: string
    destination: string
    requestRate: number
    errorRate: number
    p95LatencyMs?: number | null
  }>
  // ns 필터 적용 전 전체 그래프에서 관측된 네임스페이스 목록 (드롭다운용)
  namespaces?: string[]
  notice?: string
}

export async function GET(req: NextRequest) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  try {
    const { searchParams } = req.nextUrl
    const windowParam = searchParams.get("window") ?? "7d"
    const namespaceParam = searchParams.get("namespace") ?? undefined
    const minRateParam = searchParams.get("minRate")

    // window 파라미터 검증
    if (!isAllowedWindow(windowParam)) {
      throw new ValidationError("window must be one of: 1h, 1d, 7d, 30d", "window")
    }

    // minRate 파라미터 검증
    let minRate: number | undefined = undefined
    if (minRateParam !== null) {
      const parsed = parseFloat(minRateParam)
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        throw new ValidationError("minRate must be a non-negative number", "minRate")
      }
      minRate = parsed
    }

    const result = await getServiceGraph(windowParam, namespaceParam, minRate)

    const response: ServiceGraphResponse = {
      window: result.window,
      generatedAt: result.generatedAt,
      nodes: result.nodes,
      edges: result.edges,
      ...(result.namespaces ? { namespaces: result.namespaces } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
    }

    return NextResponse.json(response)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[api/service-graph]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
