import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getPodDetail, PodDetail } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export type { PodDetail }

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const kind = searchParams.get("kind")
  const namespace = searchParams.get("namespace")
  const name = searchParams.get("name")

  if (!kind || !namespace || !name) {
    return NextResponse.json(
      { error: "ValidationError", message: "kind, namespace, and name are required parameters", field: "params" },
      { status: 400 }
    )
  }

  if (kind !== "Pod") {
    return NextResponse.json(
      { error: "ValidationError", message: "Only kind=Pod is supported at this time", field: "kind" },
      { status: 400 }
    )
  }

  const cacheKey = `k8s:resource:${namespace}:${name}`
  try {
    const cached = await cacheGet<PodDetail>(cacheKey)
    if (cached) {
      return NextResponse.json<PodDetail>(cached)
    }
  } catch (err) {
    console.warn("[k8s-resource-api] Cache lookup failed:", err)
  }

  try {
    const detail = await getPodDetail(namespace, name)

    try {
      await cacheSet(cacheKey, detail, 10) // 10s cache
    } catch (err) {
      console.warn("[k8s-resource-api] Cache save failed:", err)
    }

    return NextResponse.json<PodDetail>(detail)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error(`[k8s-resource-api] Error fetching pod detail ${namespace}/${name}:`, err)
    return NextResponse.json({ error: "Internal Server Error", message: (err as Error).message }, { status: 500 })
  }
}
