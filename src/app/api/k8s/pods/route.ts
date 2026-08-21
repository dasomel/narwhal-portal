import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getPodsList, PodSummary } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { ValidationError, toValidationErrorBody, assertK8sNamespace } from "@/lib/validation"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"

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

  // The namespace is a caller-supplied parameter, and nothing checked whether the
  // caller may read it. Any session could name `iam`, `database` or
  // `platform-system` and read what runs there — pod details carry images, nodes,
  // env var names and container state. The namespace list itself is scoped now
  // (/api/namespaces), so leaving this open would just mean guessing a name.
  //
  // VALIDATE BEFORE AUTHORIZING. The scope patterns are prefix matches, so a value
  // like "platform-system/../iam" satisfies `platform-*` while naming a different
  // namespace. The downstream getPodsList/getPodDetail do call assertK8sNamespace
  // and would reject it, but that makes the rejection incidental: the authorization
  // decision would have been made on a string that is not a namespace, and it is
  // also what the cache key is built from. Deciding on a canonical value keeps the
  // guard from depending on a check further down the call stack.
  //
  // The cache keys here are already namespace-scoped, so the authorization gap was
  // a missing check rather than a leak between callers.
  try {
    assertK8sNamespace(namespace)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }

  const scope = await getEffectiveScope(session)
  if (!namespaceVisible(namespace, scope)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
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
