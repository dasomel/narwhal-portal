import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"
import {
  assertK8sName,
  assertK8sNamespace,
  safeK8sSegment,
  ValidationError,
  toValidationErrorBody,
} from "@/lib/validation"

export const dynamic = "force-dynamic"

export interface PodLogsResponse {
  logs: string
  container: string
  pod: string
  namespace: string
}

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? "https://192.168.56.100:6443"
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""

const ALLOWED_ROLES = ["cluster-admin", "developer", "viewer"]
const CONTAINER_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export async function GET(
  req: Request,
  { params }: { params: Promise<{ namespace: string; pod: string }> }
): Promise<NextResponse> {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const role = session.user?.role
  if (!role || !ALLOWED_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { namespace, pod } = await params
  try {
    assertK8sNamespace(namespace)
    assertK8sName(pod, "pod")
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }
  const { searchParams } = new URL(req.url)
  const container = searchParams.get("container") ?? ""
  if (container && !CONTAINER_NAME_RE.test(container)) {
    return NextResponse.json(
      { error: "ValidationError", message: "invalid container name", field: "container" },
      { status: 400 },
    )
  }
  const tailLines = Math.min(Number(searchParams.get("tailLines") ?? "200"), 1000)
  const previous = searchParams.get("previous") === "true"

  const cacheKey = `pods:logs:${namespace}:${pod}:${container}:${tailLines}:${previous}`
  const cached = await cacheGet<PodLogsResponse>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const query = new URLSearchParams({ tailLines: String(tailLines) })
    if (container) query.set("container", container)
    if (previous) query.set("previous", "true")

    const path = `/api/v1/namespaces/${safeK8sSegment(namespace)}/pods/${safeK8sSegment(pod)}/log?${query}`
    const res = await fetch(`${K8S_API_SERVER}${path}`, {
      headers: {
        Authorization: `Bearer ${K8S_TOKEN}`,
        // K8s pod-log subresource rejects `Accept: text/plain` with 406 on this API server;
        // `*/*` returns the plain-text log body (we read it via res.text() below).
        Accept: "*/*",
      },
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      console.error(`[api/pods/logs] K8s API ${res.status}: ${path}`, errText)
      return NextResponse.json({ error: `K8s API error: ${res.status}` }, { status: res.status })
    }

    const logs = await res.text()
    const result: PodLogsResponse = {
      logs,
      container: container || "default",
      pod,
      namespace,
    }

    await cacheSet(cacheKey, result, 5)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[api/pods/logs]", err)
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
  }
}
