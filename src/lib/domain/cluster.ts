/**
 * Cluster/Fleet Domain API — portal#46 pilot.
 *
 * portal#46 asks for a Narwhal-wide Domain/Management API model spanning 10+
 * object categories (Cluster, Service/App, Team, GitOps state, Operation,
 * Policy, Incident, Storage, Supply-chain, Identity, Evidence). That is
 * RFP-scale and out of reach in one pass — see docs/domain-api-cluster-fleet.md
 * for the full scoping note. This module is the ONE pilot: a genuine,
 * complete adapter/projection for the `Cluster`/`Fleet` domain object,
 * built on top of the registry portal#21 already introduced
 * (src/types/cluster.ts, src/lib/cluster-registry.ts).
 *
 * What this file is NOT: it does not talk to ArgoCD, Alertmanager, or any
 * other OSS system directly, and it does not replace src/app/api/cluster
 * (the raw K8s-shaped node/pod/namespace inventory route) — that route still
 * exists for the infra-detail view. This module answers a narrower question:
 * "is this cluster there, and which capabilities can the Portal trust right
 * now" — the fleet-level domain view, not a K8s resource browser.
 *
 * Two things kept deliberately separate, matching the pure/impure split
 * cluster-registry.ts already establishes (validateClusterRegistration vs.
 * FileClusterStore):
 *   - `deriveCapabilityState` / `projectClusterDomain` are pure — given a
 *     Cluster record and an already-resolved probe outcome, they compute the
 *     domain projection with no IO. This is what cluster.test.ts exercises
 *     directly, and what makes the offline/replay fixtures in
 *     cluster.fixtures.ts meaningful (same function, canned input).
 *   - `probeClusterHealth` is impure (network IO) and isolated to the bottom
 *     of this file. It NEVER throws — a destroyed/unreachable cluster (this
 *     session's actual state: the one real Kakao Cloud cluster was destroyed
 *     2026-08-10) degrades to `{ reachable: false, ... }`, which
 *     `projectClusterDomain` then turns into capability status "unavailable",
 *     never an uncaught exception.
 */
import type {
  Cluster,
  ClusterCapabilityProfile,
  ClusterCapabilityStatus,
  ClusterEnvironment,
  ClusterHealthStatus,
  ClusterPreflightChecks,
  ClusterProvider,
} from "@/types/cluster"
import type { EventResource } from "@/types/event-envelope"
import { deriveClusterHealth } from "@/lib/cluster-registry"

// ---------------------------------------------------------------------------
// Domain shape — this is what Portal UI/components should consume. It never
// carries a raw K8s API field name (no `metadata.name`, `status.conditions`,
// `nodeInfo.kubeletVersion`, ...); those stay inside src/app/api/cluster's
// ClusterInfra interface, which is the vendor(K8s)-shaped adapter output for
// the infra-detail view, not the domain object.
// ---------------------------------------------------------------------------

export type ClusterDomainSchemaVersion = "1.0"

export const CLUSTER_DOMAIN_SCHEMA_VERSION: ClusterDomainSchemaVersion = "1.0"

/** Where a piece of the projection's data actually came from. */
export type DomainSourceKind = "registry" | "live-probe" | "cache" | "fixture"

export interface DomainFreshness {
  /** ISO timestamp this projection was computed (or, on a cache hit, when the cached value was computed). */
  asOf: string
  source: DomainSourceKind
  /** Seconds since asOf when served from cache; null when this projection was computed fresh (or is a fixture). */
  cacheAgeSeconds: number | null
}

export interface ClusterCapabilityState {
  status: ClusterCapabilityStatus
  /** "registry" = the fleet operator's declared value stands (cluster confirmed live+authenticated, or declared not-applicable); "live-probe" = the probe itself determined this status (unreachable -> unavailable, reachable-but-unauthenticated -> partial). */
  source: DomainSourceKind
  detail?: string
}

export interface ClusterDomainObject {
  schemaVersion: ClusterDomainSchemaVersion
  id: string
  name: string
  environment: ClusterEnvironment
  provider: ClusterProvider
  region: string | null
  health: ClusterHealthStatus
  capabilities: Record<keyof ClusterCapabilityProfile, ClusterCapabilityState>
  /** portal#11 EventResource shape — lets this domain object be embedded directly in an operation/event/evidence record without re-deriving a resource ref. */
  resource: EventResource
  freshness: DomainFreshness
}

// ---------------------------------------------------------------------------
// Probe outcome — the impure adapter's contract with the pure projector.
// Deliberately a superset-free subset of ClusterPreflightChecks (cluster-
// registry.ts) so projectClusterDomain can hand it straight to
// deriveClusterHealth without adapting shapes.
// ---------------------------------------------------------------------------

export interface ClusterProbeResult {
  reachable: boolean
  authenticated: boolean
  versionKnown: boolean
  probedAt: string
  error: string | null
}

// ---------------------------------------------------------------------------
// Pure projection logic
// ---------------------------------------------------------------------------

/**
 * Capability-discovery semantics (the issue's own vocabulary: `supported`,
 * `partial`, `unavailable`, `not-applicable`). Four branches, each with a
 * distinct reason a caller needs to be able to tell apart:
 *
 *   1. Declared "not-applicable" always wins, regardless of probe outcome —
 *      a cluster that was never registered as running ArgoCD doesn't become
 *      "supported" just because the API server happens to be reachable.
 *   2. Cluster unreachable -> every other capability degrades to
 *      "unavailable". We have no live evidence a capability works if the
 *      control plane itself can't be reached.
 *   3. Cluster reachable but not authenticated -> "partial". We know the
 *      cluster is up, but can't verify capability-level access (RBAC-gated),
 *      so we can't claim the registry's declared status is currently true.
 *   4. Cluster reachable AND authenticated -> the registry's declared value
 *      passes through untouched. This module does not probe ArgoCD/metrics/
 *      events/storage/logs endpoints individually (out of scope — see
 *      docs/domain-api-cluster-fleet.md); trusting the fleet operator's
 *      declaration once basic reachability+auth is confirmed live is the
 *      honest middle ground between "never probe" and "probe everything".
 */
export function deriveCapabilityState(
  declared: ClusterCapabilityStatus,
  checks: Pick<ClusterPreflightChecks, "reachable" | "authenticated">,
): ClusterCapabilityState {
  if (declared === "not-applicable") {
    return { status: "not-applicable", source: "registry" }
  }
  if (!checks.reachable) {
    return { status: "unavailable", source: "live-probe", detail: "cluster unreachable" }
  }
  if (!checks.authenticated) {
    return { status: "partial", source: "live-probe", detail: "cluster reachable but not authenticated" }
  }
  return { status: declared, source: "registry" }
}

export interface ProjectClusterDomainOptions {
  now?: Date
  /** Overrides the computed freshness.source (e.g. "fixture" for replay data, "cache" for a cache-hit re-serve). */
  freshnessSource?: DomainSourceKind
  /** Set when re-serving a cached projection; null (default) means "computed fresh in this call". */
  cacheAgeSeconds?: number | null
}

/**
 * Projects a registered Cluster + an (optional) already-resolved probe
 * outcome into the domain shape. Pure — no IO, no throw. `probe: null` is a
 * legitimate input (e.g. credentials not configured yet) and is treated
 * identically to a probe that came back unreachable, per deriveClusterHealth
 * and deriveCapabilityState's "no false-green" convention.
 */
export function projectClusterDomain(
  cluster: Cluster,
  probe: ClusterProbeResult | null,
  opts: ProjectClusterDomainOptions = {},
): ClusterDomainObject {
  const now = opts.now ?? new Date()
  const checks: ClusterPreflightChecks = probe
    ? { reachable: probe.reachable, authenticated: probe.authenticated, versionKnown: probe.versionKnown }
    : { reachable: false, authenticated: false, versionKnown: false }

  const health = deriveClusterHealth(checks)

  const capabilityKeys = Object.keys(cluster.capabilities) as Array<keyof ClusterCapabilityProfile>
  const capabilities = {} as Record<keyof ClusterCapabilityProfile, ClusterCapabilityState>
  for (const key of capabilityKeys) {
    capabilities[key] = deriveCapabilityState(cluster.capabilities[key], checks)
  }

  return {
    schemaVersion: CLUSTER_DOMAIN_SCHEMA_VERSION,
    id: cluster.id,
    name: cluster.name,
    environment: cluster.environment,
    provider: cluster.provider,
    region: cluster.region,
    health,
    capabilities,
    resource: { cluster: cluster.id },
    freshness: {
      asOf: now.toISOString(),
      source: opts.freshnessSource ?? (probe ? "live-probe" : "fixture"),
      cacheAgeSeconds: opts.cacheAgeSeconds ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Impure adapter — the one place this module does network IO.
// ---------------------------------------------------------------------------

/**
 * Lightweight liveness/auth probe against a cluster's K8s API server. Scope
 * is deliberately narrow: reachability + auth + version, the same three
 * signals ClusterPreflightChecks already models (portal#21's own
 * "no false-green" health derivation). It does NOT probe ArgoCD/metrics/
 * events/storage/logs individually — see the capability-discovery doc
 * comment on deriveCapabilityState above and docs/domain-api-cluster-fleet.md
 * for why that's out of scope for this pilot.
 *
 * Never throws: any network failure (refused connection, DNS failure,
 * timeout — exactly what happens against the destroyed Kakao Cloud cluster
 * this session's fixtures are modeled on) resolves to
 * `{ reachable: false, ... }` rather than rejecting.
 */
export async function probeClusterHealth(
  apiServer: string,
  token: string,
  timeoutMs = 2000,
): Promise<ClusterProbeResult> {
  const probedAt = new Date().toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${apiServer}/version`, {
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    })
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, authenticated: false, versionKnown: false, probedAt, error: `HTTP ${res.status}` }
    }
    if (!res.ok) {
      return { reachable: true, authenticated: true, versionKnown: false, probedAt, error: `HTTP ${res.status}` }
    }
    const body = (await res.json().catch(() => null)) as { gitVersion?: string } | null
    return { reachable: true, authenticated: true, versionKnown: !!body?.gitVersion, probedAt, error: null }
  } catch (err) {
    return {
      reachable: false,
      authenticated: false,
      versionKnown: false,
      probedAt,
      error: err instanceof Error ? err.message : "probe failed",
    }
  } finally {
    clearTimeout(timer)
  }
}
