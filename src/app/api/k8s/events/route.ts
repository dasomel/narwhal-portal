import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getResourceEvents, ResourceEvent } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { ValidationError, toValidationErrorBody, assertK8sNamespace } from "@/lib/validation"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"

export const dynamic = "force-dynamic"

export interface ResourceEventsResponse {
  events: ResourceEvent[]
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const namespace = searchParams.get("namespace")
  const name = searchParams.get("name")

  if (!namespace || !name) {
    return NextResponse.json(
      { error: "ValidationError", message: "namespace and name are required parameters", field: "params" },
      { status: 400 }
    )
  }

  // The namespace is a caller-supplied parameter, and nothing checked whether the
  // caller may read it. Any session could name `iam`, `database` or
  // `platform-system` and read events from what runs there. Sibling routes
  // (/api/k8s/pods, /api/k8s/resource) already gate this way — see their comments
  // for why validation runs before authorization.
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

  const cacheKey = `k8s:events:${namespace}:${name}`
  try {
    const cached = await cacheGet<ResourceEvent[]>(cacheKey)
    if (cached) {
      return NextResponse.json<ResourceEventsResponse>({ events: cached })
    }
  } catch (err) {
    console.warn("[k8s-events-api] Cache lookup failed:", err)
  }

  try {
    const events = await getResourceEvents(namespace, name)

    try {
      await cacheSet(cacheKey, events, 10) // 10s cache
    } catch (err) {
      console.warn("[k8s-events-api] Cache save failed:", err)
    }

    return NextResponse.json<ResourceEventsResponse>({ events })
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error(`[k8s-events-api] Error fetching events for ${namespace}/${name}:`, err)
    return NextResponse.json({ error: "Internal Server Error", message: (err as Error).message }, { status: 500 })
  }
}
