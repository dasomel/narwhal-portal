import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { getArgoApps } from "@/lib/argocd"

export const dynamic = "force-dynamic"

export interface ArchNode {
  id: string
  label: string
  group: "gateway" | "gitops" | "monitoring" | "storage" | "security" | "platform"
  status: "healthy" | "degraded" | "offline" | "unknown"
  responseMs: number
}

export interface ArchEdge {
  source: string
  target: string
  label?: string
}

export interface ArchitectureData {
  nodes: ArchNode[]
  edges: ArchEdge[]
}

// Health source = ArgoCD application health (the cluster's own reconciler), which is
// authoritative. The previous approach HTTP-pinged external ingress hosts (*.local.narwhal.internal)
// from inside the pod — those are unreachable in-cluster, so most nodes showed offline/unknown.
function mapArgoHealth(h?: string): ArchNode["status"] {
  switch (h) {
    case "Healthy":
    case "Suspended":
      return "healthy"
    case "Degraded":
    case "Progressing":
      return "degraded"
    case "Missing":
      return "offline"
    default:
      return "unknown"
  }
}

// Architecture node id -> candidate ArgoCD Application name(s) (first match wins).
const NODE_APP: Record<string, string[]> = {
  portal: ["narwhal-portal"],
  keycloak: ["keycloak"],
  apisix: ["apisix"],
  argocd: ["argocd-config"],
  gitea: ["gitea"],
  harbor: ["harbor"],
  grafana: ["prometheus-stack"],
  prometheus: ["prometheus-stack"],
  alertmanager: ["prometheus-stack"],
  headlamp: ["headlamp"],
  hubble: ["cilium"],
  openbao: ["openbao"],
  "velero-ui": ["velero-ui", "velero"],
  cnpg: ["cnpg", "cloudnative-pg"],
  seaweedfs: ["seaweedfs"],
  istio: ["istiod", "istio-base"],
  cilium: ["cilium"],
}

const ARCHITECTURE_NODES: Omit<ArchNode, "status" | "responseMs">[] = [
  { id: "developer", label: "Developer", group: "platform" },
  { id: "portal", label: "IDP Portal", group: "platform" },
  { id: "keycloak", label: "Keycloak SSO", group: "security" },
  { id: "apisix", label: "APISIX Gateway", group: "gateway" },
  { id: "argocd", label: "ArgoCD", group: "gitops" },
  { id: "gitea", label: "Gitea", group: "gitops" },
  { id: "harbor", label: "Harbor", group: "storage" },
  { id: "grafana", label: "Grafana", group: "monitoring" },
  { id: "prometheus", label: "Prometheus", group: "monitoring" },
  { id: "alertmanager", label: "Alertmanager", group: "monitoring" },
  { id: "headlamp", label: "Headlamp", group: "platform" },
  { id: "hubble", label: "Hubble UI", group: "platform" },
  { id: "openbao", label: "OpenBao", group: "security" },
  { id: "velero-ui", label: "Velero UI", group: "storage" },
  { id: "k8s", label: "Kubernetes", group: "platform" },
  { id: "cnpg", label: "PostgreSQL (CNPG)", group: "storage" },
  { id: "seaweedfs", label: "SeaweedFS", group: "storage" },
  { id: "istio", label: "Istio Mesh", group: "gateway" },
  { id: "cilium", label: "Cilium CNI", group: "gateway" },
]

const ARCHITECTURE_EDGES: ArchEdge[] = [
  { source: "developer", target: "portal", label: "HTTPS" },
  { source: "developer", target: "apisix", label: "HTTPS" },
  { source: "portal", target: "keycloak", label: "OIDC" },
  { source: "portal", target: "prometheus", label: "PromQL" },
  { source: "portal", target: "argocd", label: "API" },
  { source: "portal", target: "alertmanager", label: "API" },
  { source: "apisix", target: "argocd", label: "proxy" },
  { source: "apisix", target: "gitea", label: "proxy" },
  { source: "apisix", target: "harbor", label: "proxy" },
  { source: "apisix", target: "grafana", label: "proxy" },
  { source: "apisix", target: "headlamp", label: "proxy" },
  { source: "apisix", target: "hubble", label: "proxy" },
  { source: "apisix", target: "openbao", label: "proxy" },
  { source: "apisix", target: "velero-ui", label: "proxy" },
  { source: "keycloak", target: "cnpg", label: "SQL" },
  { source: "gitea", target: "argocd", label: "webhook" },
  { source: "argocd", target: "k8s", label: "deploy" },
  { source: "harbor", target: "k8s", label: "pull" },
  { source: "prometheus", target: "k8s", label: "scrape" },
  { source: "prometheus", target: "alertmanager", label: "alert" },
  { source: "grafana", target: "prometheus", label: "query" },
  { source: "k8s", target: "cnpg", label: "operator" },
  { source: "k8s", target: "seaweedfs", label: "CSI" },
  { source: "k8s", target: "istio", label: "mesh" },
  { source: "k8s", target: "cilium", label: "CNI" },
  { source: "openbao", target: "k8s", label: "inject" },
]

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cacheKey = "architecture:topology"
  const cached = await cacheGet<ArchitectureData>(cacheKey)
  if (cached) return NextResponse.json(cached)

  const apps = await getArgoApps()
  const healthByName = new Map(apps.map((a) => [a.metadata.name, a.status?.health?.status]))
  const argoReachable = apps.length > 0

  function resolveStatus(id: string): ArchNode["status"] {
    // "developer" is the human actor (always present).
    if (id === "developer") return "healthy"
    // k8s = control plane, gitea = the GitOps source ArgoCD pulls from. Neither is an
    // ArgoCD app; if ArgoCD returned apps then both are serving → healthy.
    if (id === "k8s" || id === "gitea") return argoReachable ? "healthy" : "unknown"
    for (const appName of NODE_APP[id] ?? [id]) {
      if (healthByName.has(appName)) return mapArgoHealth(healthByName.get(appName))
    }
    return "unknown"
  }

  const data: ArchitectureData = {
    nodes: ARCHITECTURE_NODES.map((node) => ({ ...node, status: resolveStatus(node.id), responseMs: 0 })),
    edges: ARCHITECTURE_EDGES,
  }

  await cacheSet(cacheKey, data, 30)
  return NextResponse.json(data)
}
