import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getPodDetail, PodDetail } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { ValidationError, toValidationErrorBody, assertK8sNamespace } from "@/lib/validation"
import { getVisibilityScope, namespaceMatchesScope } from "@/lib/role-filter"

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

  const scope = getVisibilityScope(session.groups ?? [], session.teams ?? [])
  if (!namespaceMatchesScope(namespace, scope.namespaces)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
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
