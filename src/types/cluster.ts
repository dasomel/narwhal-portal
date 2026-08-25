/**
 * Cluster domain types — portal#21 (Multi-Cluster Registration / Cluster Context).
 *
 * Today the portal talks to exactly one cluster through a single global
 * `K8S_API_SERVER`/`K8S_SA_TOKEN` env pair (src/lib/k8s-client.ts, src/lib/config.ts)
 * and a single global cache key (`cluster:infra`). This file defines the shape a
 * registered cluster takes once that assumption is lifted: a stable `id`, metadata,
 * a credential *reference* (never a raw token/kubeconfig — see ClusterCredentialRef),
 * and a capability profile that lets clusters legitimately differ instead of the
 * portal assuming they're identical.
 *
 * `DEFAULT_CLUSTER_ID` and `isValidClusterId` live here (pure, zero IO deps) rather
 * than in src/lib/cluster-registry.ts so src/lib/scope.ts and src/lib/role-filter.ts
 * can depend on the cluster_id concept without pulling in the registry's
 * file-IO/store machinery — the same split event-envelope.ts draws between its
 * types + isValidEventActor/isValidEventResource and the modules that populate them.
 */

export type ClusterEnvironment = "production" | "staging" | "development" | "sandbox"

export type ClusterProvider = "kakao-cloud" | "aws" | "gcp" | "azure" | "on-prem" | "other"

/** Fleet-health status for one cluster — never inferred as "healthy" by default (see deriveClusterHealth). */
export type ClusterHealthStatus = "unknown" | "healthy" | "degraded" | "offline"

/**
 * Per-capability support level. Explicit rather than assumed: a capability a
 * cluster doesn't run (e.g. no ArgoCD) is "not-applicable", one that's down or
 * misconfigured is "unavailable" — the two must not collapse into a single
 * boolean or the fleet view can't distinguish "this cluster never had ArgoCD"
 * from "ArgoCD just broke on this cluster".
 */
export type ClusterCapabilityStatus = "supported" | "partial" | "unavailable" | "not-applicable"

export interface ClusterCapabilityProfile {
  argocd: ClusterCapabilityStatus
  metrics: ClusterCapabilityStatus
  events: ClusterCapabilityStatus
  storage: ClusterCapabilityStatus
  rbac: ClusterCapabilityStatus
  logs: ClusterCapabilityStatus
}

export const DEFAULT_CAPABILITY_PROFILE: ClusterCapabilityProfile = {
  argocd: "unavailable",
  metrics: "unavailable",
  events: "unavailable",
  storage: "unavailable",
  rbac: "unavailable",
  logs: "unavailable",
}

/**
 * Points at where a cluster's real credential material lives — an env var pair,
 * matching the pattern src/lib/k8s-client.ts and src/lib/config.ts already use
 * for the single cluster today (`K8S_API_SERVER` / `K8S_SA_TOKEN`). Never holds
 * the token/kubeconfig value itself: `resolveClusterCredentials()` in
 * src/lib/cluster-registry.ts is the one place that reads the named env vars,
 * and this shape is what gets persisted to config/clusters.json — a raw secret
 * accidentally placed here would end up committed to Git.
 */
export interface ClusterCredentialRef {
  apiServerEnvVar: string
  tokenEnvVar: string
}

export interface Cluster {
  /** Stable slug — see CLUSTER_ID_RE. Used verbatim in cache keys (cluster:{id}:...). */
  id: string
  name: string
  environment: ClusterEnvironment
  provider: ClusterProvider
  region: string | null
  /** Human-readable hint only (e.g. "VIP :6443") — never a duplicate of the live endpoint value. */
  endpointHint: string | null
  credentialRef: ClusterCredentialRef
  capabilities: ClusterCapabilityProfile
  status: ClusterHealthStatus
  registeredAt: string
  updatedAt: string
}

/** POST /api/settings/clusters body shape. */
export interface ClusterRegistrationInput {
  id: string
  name: string
  environment: ClusterEnvironment
  provider: ClusterProvider
  region?: string | null
  endpointHint?: string | null
  credentialRef: ClusterCredentialRef
  capabilities?: Partial<ClusterCapabilityProfile>
}

/** Inputs to deriveClusterHealth — outcomes of a (possibly unexecuted) preflight probe. */
export interface ClusterPreflightChecks {
  reachable: boolean
  authenticated: boolean
  versionKnown: boolean
}

// RFC 1123 label, same rule this codebase already applies to K8s names
// (src/lib/validation.ts K8S_NAME_RE) — cluster ids are used verbatim inside
// cache keys (`cluster:{id}:...`), so anything outside this charset risks a
// cache-key injection (e.g. an id containing ":" could be crafted to collide
// with another cluster's key).
export const CLUSTER_ID_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export function isValidClusterId(id: string): boolean {
  return CLUSTER_ID_RE.test(id)
}

/**
 * The cluster every existing route implicitly talks to today. Every call site
 * that predates portal#21 (getEffectiveScope, scopeFingerprint, beginOperation)
 * defaults to this id, which keeps their behavior byte-for-byte identical until
 * a route is explicitly updated to resolve a real per-request cluster_id.
 */
export const DEFAULT_CLUSTER_ID = "primary"

const ENVIRONMENTS: ClusterEnvironment[] = ["production", "staging", "development", "sandbox"]
const PROVIDERS: ClusterProvider[] = ["kakao-cloud", "aws", "gcp", "azure", "on-prem", "other"]
const CAPABILITY_STATUSES: ClusterCapabilityStatus[] = ["supported", "partial", "unavailable", "not-applicable"]

export function isClusterEnvironment(v: unknown): v is ClusterEnvironment {
  return typeof v === "string" && (ENVIRONMENTS as string[]).includes(v)
}

export function isClusterProvider(v: unknown): v is ClusterProvider {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v)
}

export function isClusterCapabilityStatus(v: unknown): v is ClusterCapabilityStatus {
  return typeof v === "string" && (CAPABILITY_STATUSES as string[]).includes(v)
}
