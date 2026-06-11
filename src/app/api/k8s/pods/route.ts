import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getPodsList, PodSummary } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export interface PodListResponse {
  pods: PodSummary[]
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const namespace = searchParams.get("namespace")
  const app = searchParams.get("app") || undefined

  if (!namespace) {
    return NextResponse.json(
      { error: "ValidationError", message: "namespace is required", field: "namespace" },
      { status: 400 }
    )
  }

  const cacheKey = `k8s:pods:${namespace}:${app ?? "all"}`
  try {
    const cached = await cacheGet<PodSummary[]>(cacheKey)
    if (cached) {
      return NextResponse.json<PodListResponse>({ pods: cached })
    }
  } catch (err) {
    console.warn("[k8s-pods-api] Cache lookup failed:", err)
  }

  try {
    const pods = await getPodsList(namespace, app)
    
    try {
      await cacheSet(cacheKey, pods, 10) // 10s cache
    } catch (err) {
      console.warn("[k8s-pods-api] Cache save failed:", err)
    }

    return NextResponse.json<PodListResponse>({ pods })
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("[k8s-pods-api] Error listing pods:", err)
    return NextResponse.json({ error: "Internal Server Error", message: (err as Error).message }, { status: 500 })
  }
}
