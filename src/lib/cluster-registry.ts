/**
 * Cluster registry — portal#21 (Multi-Cluster Registration / Cluster Context).
 *
 * Persistence decision (recorded here since there's no ADR file in this repo):
 * clusters are stored as JSON at config/clusters.json, read the same way
 * config/role-filter.json is (src/lib/role-filter.ts's loadConfig — readFileSync
 * from process.cwd()/config, cached in a module-level variable). Two alternatives
 * were considered and rejected for this pass:
 *
 *   - A K8s ConfigMap in the portal's own namespace. Rejected because the portal's
 *     ServiceAccount only has read RBAC today (`namespaces: [get, list, watch]`,
 *     see the createNamespace removal note in k8s-client.ts) — writing a ConfigMap
 *     would need new cluster-side RBAC, which is exactly the narwhal#6 coordination
 *     this issue is blocked on and can't be granted from the portal repo alone.
 *   - A database. Rejected because this stack has none; adding one is a much
 *     bigger decision than cluster registration deserves on its own.
 *
 * A file-based store also satisfies the issue's own acceptance criterion directly:
 * "Offline bootstrap/replay can reproduce the registered cluster inventory and
 * credential references without storing raw credentials in Git" — a git-committed
 * JSON file IS that replayable artifact, as long as it only ever holds credential
 * REFERENCES (env var names — see ClusterCredentialRef), never raw secret values.
 *
 * Known limitation, stated plainly rather than papered over: POST/DELETE below
 * write straight to config/clusters.json via fs.writeFileSync. That works for a
 * single-replica process with a writable filesystem. It does NOT survive a
 * redeploy or propagate across replicas in a multi-pod deployment — there is no
 * shared volume or ConfigMap backing it yet. The `ClusterStore` interface below
 * exists so a real backend (ConfigMap once write RBAC lands, or a database) can
 * replace FileClusterStore later without touching the CRUD route or the pure
 * validation logic, the same way IdempotencyStore (src/lib/idempotency.ts)
 * decouples claimIdempotencyKey from its Valkey-backed implementation.
 */
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { ValidationError } from "./validation"
import {
  type Cluster,
  type ClusterCredentialRef,
  type ClusterHealthStatus,
  type ClusterPreflightChecks,
  type ClusterRegistrationInput,
  CLUSTER_ID_RE,
  DEFAULT_CAPABILITY_PROFILE,
  DEFAULT_CLUSTER_ID,
  isClusterEnvironment,
  isClusterProvider,
  isClusterCapabilityStatus,
  isValidClusterId,
} from "@/types/cluster"

export type { Cluster, ClusterRegistrationInput } from "@/types/cluster"
export { DEFAULT_CLUSTER_ID }

// ---------------------------------------------------------------------------
// Store abstraction (injectable — see file header)
// ---------------------------------------------------------------------------

export interface ClusterStore {
  list(): Promise<Cluster[]>
  put(cluster: Cluster): Promise<void>
  remove(id: string): Promise<boolean>
}

interface ClustersFile {
  clusters: Cluster[]
}

const CONFIG_PATH = () => join(process.cwd(), "config", "clusters.json")

export class FileClusterStore implements ClusterStore {
  private cache: Cluster[] | null = null

  private load(): Cluster[] {
    if (this.cache) return this.cache
    try {
      const raw = readFileSync(CONFIG_PATH(), "utf-8")
      const parsed = JSON.parse(raw) as ClustersFile
      this.cache = Array.isArray(parsed.clusters) ? parsed.clusters : []
    } catch (err) {
      console.warn("[cluster-registry] Could not load config/clusters.json, using empty registry:", (err as Error).message)
      this.cache = []
    }
    return this.cache
  }

  private persist(clusters: Cluster[]): void {
    this.cache = clusters
    try {
      writeFileSync(CONFIG_PATH(), JSON.stringify({ clusters }, null, 2) + "\n", "utf-8")
    } catch (err) {
      // Non-fatal by the same convention cacheSet failure is (src/lib/valkey.ts):
      // the in-memory registry still reflects the change for this process's
      // lifetime, but it will NOT survive a restart. Logged loudly (not
      // swallowed) because unlike a cache miss, this one has no self-healing
      // retry path.
      console.warn("[cluster-registry] Failed to persist config/clusters.json — change is in-memory only for this process:", (err as Error).message)
    }
  }

  async list(): Promise<Cluster[]> {
    return [...this.load()]
  }

  async put(cluster: Cluster): Promise<void> {
    const existing = this.load()
    const next = [...existing.filter((c) => c.id !== cluster.id), cluster]
    this.persist(next)
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.load()
    const next = existing.filter((c) => c.id !== id)
    if (next.length === existing.length) return false
    this.persist(next)
    return true
  }
}

let defaultStore: ClusterStore | null = null

export function getClusterStore(): ClusterStore {
  if (!defaultStore) defaultStore = new FileClusterStore()
  return defaultStore
}

// ---------------------------------------------------------------------------
// Pure logic — validation, health derivation, cache keys.
//
// Kept dependency-free of the store/fs, the same way role-filter.ts keeps
// resolveNamespaceScope pure and IO in loadConfig: these are what
// cluster-registry.test.ts exercises directly, without touching the filesystem.
// ---------------------------------------------------------------------------

function assertValidCredentialRef(ref: unknown, field: string): asserts ref is ClusterCredentialRef {
  if (!ref || typeof ref !== "object") {
    throw new ValidationError(`${field} is required`, field)
  }
  const r = ref as Record<string, unknown>
  if (typeof r.apiServerEnvVar !== "string" || r.apiServerEnvVar.trim().length === 0) {
    throw new ValidationError(`${field}.apiServerEnvVar is required`, `${field}.apiServerEnvVar`)
  }
  if (typeof r.tokenEnvVar !== "string" || r.tokenEnvVar.trim().length === 0) {
    throw new ValidationError(`${field}.tokenEnvVar is required`, `${field}.tokenEnvVar`)
  }
}

/**
 * Validates a registration request against the currently-registered clusters and
 * returns the full Cluster record ready to persist. Pure — takes `existing`
 * rather than reading the store itself, so it's directly unit-testable (this is
 * the "extract decision logic" convention: see alert-silence-scope.ts,
 * namespace-ownership.ts).
 *
 * Two isolation checks matter more than field presence here, because they're
 * what the issue's acceptance criteria actually hinge on:
 *   - duplicate id -> rejected, so "register at least 2 independent clusters"
 *     is a real, distinct-identity operation, not silently overwriting one.
 *   - a credential env var reused across clusters -> rejected, because two
 *     clusters resolving the SAME env var would mean cluster B silently reads
 *     cluster A's credentials — the exact cross-cluster leak the issue's
 *     negative-test acceptance criterion is about, caught at registration time
 *     instead of at request time.
 */
export function validateClusterRegistration(input: ClusterRegistrationInput, existing: Cluster[]): Cluster {
  if (typeof input.id !== "string" || !isValidClusterId(input.id)) {
    throw new ValidationError(`id must match ${CLUSTER_ID_RE.source}`, "id")
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new ValidationError("name is required", "name")
  }
  if (!isClusterEnvironment(input.environment)) {
    throw new ValidationError("environment must be one of production|staging|development|sandbox", "environment")
  }
  if (!isClusterProvider(input.provider)) {
    throw new ValidationError("provider must be one of kakao-cloud|aws|gcp|azure|on-prem|other", "provider")
  }
  assertValidCredentialRef(input.credentialRef, "credentialRef")

  if (existing.some((c) => c.id === input.id)) {
    throw new ValidationError(`cluster id '${input.id}' is already registered`, "id")
  }
  const apiServerVar = input.credentialRef.apiServerEnvVar
  const tokenVar = input.credentialRef.tokenEnvVar
  for (const c of existing) {
    if (c.credentialRef.apiServerEnvVar === apiServerVar || c.credentialRef.tokenEnvVar === apiServerVar) {
      throw new ValidationError(`credentialRef.apiServerEnvVar '${apiServerVar}' is already used by cluster '${c.id}'`, "credentialRef.apiServerEnvVar")
    }
    if (c.credentialRef.tokenEnvVar === tokenVar || c.credentialRef.apiServerEnvVar === tokenVar) {
      throw new ValidationError(`credentialRef.tokenEnvVar '${tokenVar}' is already used by cluster '${c.id}'`, "credentialRef.tokenEnvVar")
    }
  }

  if (input.capabilities) {
    for (const [key, value] of Object.entries(input.capabilities)) {
      if (value !== undefined && !isClusterCapabilityStatus(value)) {
        throw new ValidationError(`capabilities.${key} must be one of supported|partial|unavailable|not-applicable`, `capabilities.${key}`)
      }
    }
  }

  const now = new Date().toISOString()
  return {
    id: input.id,
    name: input.name.trim(),
    environment: input.environment,
    provider: input.provider,
    region: input.region ?? null,
    endpointHint: input.endpointHint ?? null,
    credentialRef: input.credentialRef,
    capabilities: { ...DEFAULT_CAPABILITY_PROFILE, ...input.capabilities },
    status: "unknown",
    registeredAt: now,
    updatedAt: now,
  }
}

/**
 * Whether `id` may be de-registered given the rest of the fleet. A fleet with
 * zero registered clusters is a portal that can serve no cluster-scoped route
 * at all, which is a worse failure mode than an admin having to register a
 * replacement first — so removing the last cluster is refused rather than
 * silently leaving the registry empty.
 */
export function canRemoveCluster(id: string, existing: Cluster[]): { ok: true } | { ok: false; message: string } {
  const target = existing.find((c) => c.id === id)
  if (!target) return { ok: false, message: `cluster '${id}' is not registered` }
  if (existing.length <= 1) {
    return { ok: false, message: "cannot remove the last registered cluster — register a replacement first" }
  }
  return { ok: true }
}

/**
 * Preflight-check outcomes -> fleet health status. Pure and total: every input
 * combination maps to exactly one of the four ClusterHealthStatus values, so a
 * caller never has to invent a default — the "no false-green" acceptance
 * criterion lives here as an exhaustive function rather than an inline if-chain
 * a future route could get wrong.
 */
export function deriveClusterHealth(checks: ClusterPreflightChecks): ClusterHealthStatus {
  if (!checks.reachable) return "offline"
  if (!checks.authenticated) return "degraded"
  if (!checks.versionKnown) return "degraded"
  return "healthy"
}

/**
 * Cluster-scoped cache key, matching the issue's own spec verbatim
 * (`cluster:{cluster_id}:...`) and the shape scopeFingerprint/role-filter.ts
 * already establish for other cache-key components. Rejects a clusterId
 * outside CLUSTER_ID_RE rather than interpolating it unchecked — a `:` or
 * other separator-shaped id could otherwise be crafted to collide with a
 * different cluster's key (see isValidClusterId's own doc comment).
 */
export function clusterCacheKey(clusterId: string, resource: string): string {
  if (!isValidClusterId(clusterId)) {
    throw new ValidationError(`invalid cluster id for cache key: '${clusterId}'`, "clusterId")
  }
  return `cluster:${clusterId}:${resource}`
}

/**
 * Reads the live credential material a cluster's ClusterCredentialRef points
 * at. Impure (process.env) by necessity — this is the one place raw
 * credentials are ever read, mirroring how src/lib/k8s-client.ts and
 * src/lib/config.ts read K8S_API_SERVER/K8S_SA_TOKEN today. Returns null
 * rather than throwing when the referenced apiServer env var is unset, since
 * "credentials not configured for this cluster yet" is an expected state for
 * a freshly-registered cluster, not a bug.
 */
export function resolveClusterCredentials(cluster: Cluster): { apiServer: string; token: string } | null {
  const apiServer = process.env[cluster.credentialRef.apiServerEnvVar]
  if (!apiServer) return null
  const token = process.env[cluster.credentialRef.tokenEnvVar] ?? ""
  return { apiServer, token }
}

// ---------------------------------------------------------------------------
// Orchestration (impure — thin wrappers over the store + pure logic above)
// ---------------------------------------------------------------------------

export async function listClusters(store: ClusterStore = getClusterStore()): Promise<Cluster[]> {
  return store.list()
}

export async function getCluster(id: string, store: ClusterStore = getClusterStore()): Promise<Cluster | null> {
  const all = await store.list()
  return all.find((c) => c.id === id) ?? null
}

export async function registerCluster(
  input: ClusterRegistrationInput,
  store: ClusterStore = getClusterStore(),
): Promise<Cluster> {
  const existing = await store.list()
  const cluster = validateClusterRegistration(input, existing)
  await store.put(cluster)
  return cluster
}

export async function removeCluster(id: string, store: ClusterStore = getClusterStore()): Promise<{ ok: true } | { ok: false; message: string }> {
  const existing = await store.list()
  const verdict = canRemoveCluster(id, existing)
  if (!verdict.ok) return verdict
  await store.remove(id)
  return { ok: true }
}
