import { cacheGet, cacheSet } from "./valkey"
import { cacheKeys, cacheTtl } from "./cache-keys"
import { getArgoAppsOrThrow } from "./argocd"
import { getAlertsOrThrow } from "./alertmanager"
import { getNodeReadiness, getControlPlaneHealth, type ControlPlanePodHealth } from "./k8s-client"
import type { PlatformStatus, StatusComponent, StatusIncident, ComponentStatus } from "@/types/api"

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

/** ArgoCD app name -> component id/name/category. Multiple app names may alias one component id. */
const ARGO_COMPONENT_MAP: Record<string, { id: string; name: string; category: StatusComponent["category"] }> = {
  apisix: { id: "apisix", name: "APISIX", category: "networking" },
  keycloak: { id: "keycloak", name: "Keycloak", category: "identity" },
  harbor: { id: "harbor", name: "Harbor", category: "registry" },
  argocd: { id: "argocd", name: "ArgoCD", category: "gitops" },
  "prometheus-stack": { id: "prometheus-stack", name: "Prometheus", category: "observability" },
  grafana: { id: "grafana", name: "Grafana", category: "observability" },
  loki: { id: "loki", name: "Loki", category: "observability" },
  tempo: { id: "tempo", name: "Tempo", category: "observability" },
  openbao: { id: "openbao", name: "OpenBao", category: "storage" },
  cilium: { id: "cilium", name: "Cilium", category: "networking" },
  coredns: { id: "coredns", name: "CoreDNS", category: "networking" },
  cnpg: { id: "cnpg", name: "CloudNativePG", category: "database" },
  database: { id: "cnpg", name: "CloudNativePG", category: "database" }, // alias: some installs name the app "database"
}

/**
 * Static blast-radius map (id -> user-facing impact if this component goes down).
 * Values are drawn from prior chaos-test findings on this cluster (mesh cascade,
 * STRICT mTLS exceptions, host-overload cascade — see idp memory) rather than
 * derived at runtime: dependency edges don't change often enough to justify a live
 * discovery pass, and a wrong "impacts" list during an actual incident is worse
 * than a slightly stale static one. Components not listed here have no known
 * cross-cutting impact and get an empty impacts array.
 */
const DEPENDENCY_MAP: Record<string, string[]> = {
  apiserver: ["all"],
  etcd: ["all"],
  apisix: ["ingress: all external UIs (portal, grafana, harbor, argocd, keycloak)"],
  keycloak: ["new logins / SSO (existing JWT sessions survive)"],
  coredns: ["cluster DNS + pod networking"],
  cilium: ["cluster DNS + pod networking"],
  argocd: ["new GitOps syncs (running apps unaffected)"],
  harbor: ["new image pulls (running pods unaffected)"],
  "prometheus-stack": ["metrics + portal dashboards"],
  openbao: ["secret sync (external-secrets)"],
  cnpg: ["Keycloak DB, Harbor DB"],
}

/** Categories whose outage is treated as a platform-wide "down", not just "degraded". */
const CRITICAL_CATEGORIES = new Set<StatusComponent["category"]>(["control-plane", "networking", "identity"])

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

function controlPlaneComponent(
  id: "apiserver" | "etcd",
  name: string,
  matchToken: string,
  pods: ControlPlanePodHealth[],
): StatusComponent {
  const matched = pods.filter((p) => p.name.includes(matchToken))
  const running = matched.filter((p) => p.status === "Running").length
  let status: ComponentStatus
  if (matched.length === 0) status = "unknown"
  else if (running === matched.length) status = "healthy"
  else if (running > 0) status = "degraded"
  else status = "down"

  return {
    id,
    name,
    category: "control-plane",
    status,
    detail: matched.length > 0 ? `${running}/${matched.length} pods running` : "no pods found",
    source: "k8s:control-plane-health",
    impacts: DEPENDENCY_MAP[id] ?? [],
  }
}

function argoHealthToStatus(health: string): ComponentStatus {
  switch (health) {
    case "Healthy":
      return "healthy"
    case "Degraded":
    case "Missing":
      return "down"
    case "Progressing":
      return "degraded"
    default:
      return "unknown"
  }
}

function matchIncidentComponent(
  alert: { labels: Record<string, string> },
  componentIds: string[],
): string | null {
  const haystack = [alert.labels.namespace, alert.labels.job, alert.labels.service, alert.labels.alertname]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  for (const id of componentIds) {
    if (haystack.includes(id)) return id
  }
  return null
}

function buildSummary(
  overall: ComponentStatus,
  components: StatusComponent[],
  incidents: StatusIncident[],
  unavailable: string[],
): string {
  if (overall === "healthy") return "All systems operational"
  const unhealthy = components.filter((c) => c.status === "degraded" || c.status === "down")
  const names = unhealthy.map((c) => c.id).join(", ")
  if (overall === "down") {
    return `Critical outage: ${names || "control-plane"} down`
  }
  const incidentNote = incidents.length > 0 ? `, ${incidents.length} active incident(s)` : ""
  const unavailableNote = unavailable.length > 0 ? `, status incomplete: ${unavailable.join(", ")} unreachable` : ""
  return `${unhealthy.length} component(s) degraded: ${names}${incidentNote}${unavailableNote}`
}

const COMPONENT_STATUSES: readonly string[] = ["healthy", "degraded", "down", "unknown"]

/** Cache entries are untrusted input (#53): a malformed or tampered entry must be a miss, never a served "healthy". */
function isPlatformStatus(value: unknown): value is PlatformStatus {
  if (typeof value !== "object" || value === null) return false
  const v = value as Partial<PlatformStatus>
  return (
    typeof v.overall === "string" &&
    COMPONENT_STATUSES.includes(v.overall) &&
    typeof v.summary === "string" &&
    typeof v.generatedAt === "string" &&
    Array.isArray(v.components) &&
    Array.isArray(v.incidents) &&
    typeof v.nodes?.total === "number" &&
    typeof v.nodes?.ready === "number"
  )
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function getPlatformStatus(): Promise<PlatformStatus> {
  const cached = await cacheGet<unknown>(cacheKeys.platformStatus())
  if (isPlatformStatus(cached)) return cached

  // D1 (#53): getArgoApps/getAlerts swallow failure into [] (their READ contract,
  // portal#54 D1), so a `fulfilled` result from them proves nothing — an
  // unreachable ArgoCD/Alertmanager looked like "no apps / no incidents" and was
  // reported (and cached) as All systems operational. The OrThrow variants make
  // failure observable here. Cost: a status request during an outage re-queries
  // the providers (their own timeouts bound it) because that result is not cached.
  const [nodesResult, controlPlaneResult, argoResult, alertsResult] = await Promise.allSettled([
    getNodeReadiness(),
    getControlPlaneHealth(),
    getArgoAppsOrThrow(),
    getAlertsOrThrow(),
  ])

  const nodes = nodesResult.status === "fulfilled" ? nodesResult.value : { total: 0, ready: 0 }
  const controlPlanePods = controlPlaneResult.status === "fulfilled" ? controlPlaneResult.value : []
  const argoApps = argoResult.status === "fulfilled" ? argoResult.value : []
  const alerts = alertsResult.status === "fulfilled" ? alertsResult.value : []

  const components: StatusComponent[] = [
    controlPlaneComponent("apiserver", "kube-apiserver", "kube-apiserver", controlPlanePods),
    controlPlaneComponent("etcd", "etcd", "etcd", controlPlanePods),
  ]

  for (const app of argoApps) {
    const mapping = ARGO_COMPONENT_MAP[app.metadata.name]
    if (!mapping) continue
    if (components.some((c) => c.id === mapping.id)) continue // dedupe aliases (cnpg/database)
    components.push({
      id: mapping.id,
      name: mapping.name,
      category: mapping.category,
      status: argoHealthToStatus(app.status.health.status),
      detail: `sync ${app.status.sync.status}, health ${app.status.health.status}`,
      source: "argocd",
      impacts: DEPENDENCY_MAP[mapping.id] ?? [],
    })
  }

  // Providers whose read FAILED (not "returned nothing"). Reported as `unknown`
  // components so the UI shows what we could not observe, and forced to at
  // least degraded below.
  const unavailable: string[] = []
  if (argoResult.status === "rejected") {
    unavailable.push("argocd")
    components.push({
      id: "argocd",
      name: "ArgoCD",
      category: "gitops",
      status: "unknown",
      detail: "provider unreachable",
      source: "argocd",
      impacts: DEPENDENCY_MAP.argocd ?? [],
    })
  }
  if (alertsResult.status === "rejected") {
    unavailable.push("alertmanager")
    components.push({
      id: "alertmanager",
      name: "Alertmanager",
      category: "observability",
      status: "unknown",
      detail: "provider unreachable",
      source: "alertmanager",
      impacts: [],
    })
  }

  const componentIds = components.map((c) => c.id)
  const incidents: StatusIncident[] = alerts.map((a, idx) => ({
    id: `alert-${a.labels.alertname ?? "unknown"}-${idx}`,
    severity: a.labels.severity === "critical" ? "critical" : "warning",
    title: a.labels.alertname ?? "Alert",
    component: matchIncidentComponent(a, componentIds),
    startsAt: a.startsAt,
    summary: a.annotations.summary ?? a.annotations.description ?? "",
  }))

  const anyCriticalDown = components.some((c) => CRITICAL_CATEGORIES.has(c.category) && c.status === "down")
  const anyUnhealthy = components.some((c) => c.status === "degraded" || c.status === "down")
  // "unknown" on a critical component (e.g. apiserver/etcd selector matched no
  // pods) means we CANNOT confirm the platform's core is healthy — surface that
  // as degraded rather than a falsely-green overall. Non-critical unknowns stay
  // tolerated, except an unreachable provider (`unavailable`), which is never healthy.
  const anyCriticalUnknown = components.some((c) => CRITICAL_CATEGORIES.has(c.category) && c.status === "unknown")

  let overall: ComponentStatus
  if (anyCriticalDown) overall = "down"
  else if (anyUnhealthy || anyCriticalUnknown || incidents.length > 0 || unavailable.length > 0) overall = "degraded"
  else overall = "healthy"

  const result: PlatformStatus = {
    overall,
    summary: buildSummary(overall, components, incidents, unavailable),
    nodes,
    components,
    incidents,
    generatedAt: new Date().toISOString(),
  }

  // cachesPartial is false for this namespace (cache-keys.ts): an answer built
  // with a provider missing must not be served again for the TTL as if complete.
  if (unavailable.length === 0) {
    await cacheSet(cacheKeys.platformStatus(), result, cacheTtl("platformStatus"))
  }
  return result
}
