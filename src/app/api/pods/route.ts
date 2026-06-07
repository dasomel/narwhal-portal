import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export interface PodSummary {
  name: string
  namespace: string
  status: string
  containers: string[]
  nodeName: string
}

export interface PodsResponse {
  pods: PodSummary[]
}

const K8S_API_SERVER = process.env.K8S_API_SERVER ?? "https://192.168.56.100:6443"
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""

interface K8sPodList {
  items: Array<{
    metadata: { name: string; namespace: string }
    spec: {
      nodeName?: string
      containers: Array<{ name: string }>
    }
    status: { phase?: string }
  }>
}

// Kubernetes label-value syntax (used to scope pods to one app via app.kubernetes.io/instance)
const LABEL_VALUE_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/

async function fetchPodsByNamespace(namespace: string, instance?: string): Promise<PodSummary[]> {
  const useInstance = instance && LABEL_VALUE_RE.test(instance) ? instance : undefined
  const cacheKey = `pods:list:${namespace}:${useInstance ?? "all"}`
  const cached = await cacheGet<PodSummary[]>(cacheKey)
  if (cached) return cached

  // Shared namespaces (e.g. platform-system) host many apps; scope the list to the
  // selected service's own pods via the ArgoCD instance label when provided.
  const query = useInstance
    ? `?${new URLSearchParams({ labelSelector: `app.kubernetes.io/instance=${useInstance}` })}`
    : ""
  const path = `/api/v1/namespaces/${namespace}/pods${query}`
  const res = await fetch(`${K8S_API_SERVER}${path}`, {
    headers: {
      Authorization: `Bearer ${K8S_TOKEN}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) throw new Error(`K8s API ${res.status}: ${path}`)

  const data = (await res.json()) as K8sPodList
  const pods: PodSummary[] = data.items.map((p) => ({
    name: p.metadata.name,
    namespace: p.metadata.namespace,
    status: p.status.phase ?? "Unknown",
    containers: p.spec.containers.map((c) => c.name),
    nodeName: p.spec.nodeName ?? "",
  }))

  await cacheSet(cacheKey, pods, 15)
  return pods
}

export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const namespace = searchParams.get("namespace")
  const instance = searchParams.get("instance") ?? undefined

  if (!namespace) {
    return NextResponse.json({ error: "namespace query parameter is required" }, { status: 400 })
  }

  try {
    let pods = await fetchPodsByNamespace(namespace, instance)
    // Fallback: if the instance filter matched nothing (app's pods lack the
    // app.kubernetes.io/instance label), return all namespace pods so log viewing still works.
    if (instance && pods.length === 0) {
      pods = await fetchPodsByNamespace(namespace)
    }
    return NextResponse.json({ pods } satisfies PodsResponse)
  } catch (err) {
    console.error("[api/pods]", err)
    return NextResponse.json({ error: "Failed to fetch pods" }, { status: 500 })
  }
}
