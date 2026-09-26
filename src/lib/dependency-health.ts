/**
 * Unified dependency health / freshness / degraded-state contract (portal#47).
 *
 * The Portal already has THREE overlapping "is this dependency okay" vocabularies,
 * grown independently per feature:
 *
 *  - prometheus.ts `TelemetryStatus` ("ok"|"empty"|"unavailable"|"partial"|"ambiguous"|"stale")
 *    + `EvidenceSource` (#51 ClusterMetricsProjection).
 *  - scorecard.ts `CheckResult.status` ("pass"|"fail"|"unavailable") (208c21d) — distinguishes
 *    "rule evaluated and failed" from "could not evaluate at all"; only the latter is a
 *    dependency-health concept, "pass"/"fail" are business outcomes, not dependency state.
 *  - cost.ts `CostTelemetry` ({source, queriedAt, state, reason}, #64/#136) — `state` already
 *    reuses `TelemetryStatus` verbatim (see cost.ts's D1 comment).
 *  - k8s-client.ts `listBounded()`'s `BoundedList.truncated` (#52) — a paginated read that hit
 *    its page cap before the server's continue-token ran out; the read succeeded but is
 *    incomplete, which is a "partial" dependency-health signal in this contract's terms.
 *  - /api/health/status's inline `DependencyState` ("healthy"|"degraded"|"unavailable"|
 *    "unconfigured") — an HTTP-reachability probe vocabulary, never exported.
 *
 * This module does NOT replace any of those — each stays the shape its own callers already
 * depend on (changing CostResult/ScorecardEvaluation response shapes is out of scope here).
 * It defines the one shared target vocabulary plus a `fromXxx` mapper per source so a
 * consumer that wants a normalized cross-provider health view can get one without inventing
 * a fourth vocabulary. See the `from*` functions below for the exact mapping table.
 */

import { getK8sBearerToken, invalidateK8sBearerToken } from "./k8s-token"
import { getK8sApiServer } from "./config"
import { getValkey, cacheGet, cacheSet } from "./valkey"
import { cacheKeys } from "./cache-keys"
import { fetchWithPolicy, HttpClientError } from "./http-client"
import type { TelemetryStatus } from "./prometheus"

export type DependencyName =
  | "prometheus"
  | "kubernetes"
  | "argocd"
  | "gitea"
  | "keycloak"
  | "valkey"
  | "openbao"
  | "alertmanager"
  | "loki"

// D1: deliberately NOT `= TelemetryStatus` — this contract has no place for "ambiguous"
// (a clean-signal-but-contradictory reading that's specific to metric evaluation) and adds
// "unauthorized" (a 401/403 probe outcome no existing vocabulary distinguished from a generic
// "unavailable"). The four states that DO overlap ("ok"|"empty"|"partial"|"unavailable"|
// "stale") reuse the exact same string values on purpose — see `fromTelemetryStatus`.
export type DependencyState = "ok" | "partial" | "stale" | "unavailable" | "empty" | "unauthorized"

export interface DependencyStatus {
  dependency: DependencyName
  state: DependencyState
  observedAt: string
  /** Age of the underlying evidence in seconds, when the producer tracks one (e.g. a cached projection). Omitted for a live probe. */
  freshnessSeconds?: number
  /** Short coded reason (e.g. "timeout", "http_503", "unconfigured") — never a URL, hostname, or raw error message. */
  reason?: string
  /**
   * Redacted diagnostic detail (origin+pathname only, no query/userinfo — see
   * http-client.ts's `redactUrl`). Still identifies the dependency's hostname — safe to return
   * from /api/health/dependencies only because that route is cluster-admin-only (matching
   * /api/health/status's precedent that hostnames are an admin-only diagnostics surface). A
   * future consumer exposed to a broader audience must strip this field itself.
   */
  detail?: string
}

/**
 * Maps prometheus.ts's `TelemetryStatus` (also reused verbatim by cost.ts's `CostTelemetry.state`)
 * onto this contract's `DependencyState`. Every value except "ambiguous" reuses the identical
 * string — "ambiguous" collapses to "partial" (both mean "some evidence, but not a value this
 * contract can call clean").
 */
export function fromTelemetryStatus(status: TelemetryStatus): DependencyState {
  return status === "ambiguous" ? "partial" : status
}

/**
 * Maps /api/health/status's inline HTTP-reachability vocabulary onto `DependencyState`.
 * "unconfigured" has no dedicated state in this contract (the caller wasn't even attempted) —
 * it maps to "unavailable" with that fact preserved via the `reason` field by the caller.
 */
export function fromProbeState(state: "healthy" | "degraded" | "unavailable" | "unconfigured"): DependencyState {
  switch (state) {
    case "healthy":
      return "ok"
    case "degraded":
      return "partial"
    case "unavailable":
      return "unavailable"
    case "unconfigured":
      return "unavailable"
  }
}

/**
 * Maps k8s-client.ts's `BoundedList.truncated` (#52) onto `DependencyState`: a paginated read
 * that hit `maxPages` before the continue-token ran out succeeded but is incomplete evidence,
 * which this contract calls "partial" (the same value cost.ts's `combineTelemetry` uses for
 * "some but not all of N sub-queries came back ok").
 */
export function fromBoundedListTruncated(truncated: boolean): DependencyState {
  return truncated ? "partial" : "ok"
}

/**
 * scorecard.ts's `CheckResult.status === "unavailable"` (208c21d) is the one scorecard state
 * that IS a dependency-health concept — "pass"/"fail" are rule-evaluation outcomes on data
 * that was successfully retrieved, not dependency state, and have no mapping here.
 */
export const SCORECARD_UNAVAILABLE_STATE: DependencyState = "unavailable"

const DEFAULT_PROBE_TIMEOUT_MS = 1500

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Cheap bounded-timeout reachability probe for an HTTP-based dependency (ArgoCD, Gitea,
 * Prometheus, Keycloak, ...), via http-client.ts's shared transport policy. Retry is disabled
 * — a health probe should fail fast, not spend its timeout budget on backoff. `detail` is
 * always the http-client redacted message (origin+pathname, no query/userinfo) — still a
 * hostname, so the endpoint layer must strip it for non-admin callers.
 */
export async function probeHttpDependency(
  dependency: DependencyName,
  url: string | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<DependencyStatus> {
  const observedAt = nowIso()
  if (!url) {
    return { dependency, state: "unavailable", observedAt, reason: "unconfigured" }
  }
  try {
    const res = await fetchWithPolicy(
      url,
      { method: "GET" },
      { timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, retry: false }
    )
    if (res.status === 401 || res.status === 403) {
      return { dependency, state: "unauthorized", observedAt, reason: `http_${res.status}` }
    }
    return {
      dependency,
      state: res.ok ? "ok" : "partial",
      observedAt,
      ...(res.ok ? {} : { reason: `http_${res.status}` }),
    }
  } catch (err) {
    if (err instanceof HttpClientError) {
      return { dependency, state: "unavailable", observedAt, reason: err.kind, detail: err.message }
    }
    return { dependency, state: "unavailable", observedAt, reason: "unknown_error" }
  }
}

/**
 * Cheap reachability probe for the in-cluster Kubernetes API: a single-item, single-page read
 * against `/api/v1/namespaces`. Deliberately ignores list *completeness* (whether a fuller read
 * would paginate) — that's not an API-reachability signal, only whether the one bounded read
 * that this probe issues succeeded. Genuinely cancellable: an `AbortController` tied to
 * `timeoutMs` is passed as the fetch `signal`, so a timeout actually aborts the in-flight
 * request instead of leaving it to run to completion in the background (the previous
 * `Promise.race` version only raced a timer against the fetch promise — the fetch itself kept
 * running, and its socket, past the logical timeout).
 */
export async function probeK8sDependency(opts: { timeoutMs?: number } = {}): Promise<DependencyStatus> {
  const observedAt = nowIso()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await k8sProbeFetch(controller.signal)
    return { dependency: "kubernetes", state: "ok", observedAt }
  } catch (err) {
    if (controller.signal.aborted) {
      return { dependency: "kubernetes", state: "unavailable", observedAt, reason: "timeout" }
    }
    const status = (err as { status?: number } | undefined)?.status
    if (status === 401 || status === 403) {
      return { dependency: "kubernetes", state: "unauthorized", observedAt, reason: `http_${status}` }
    }
    return {
      dependency: "kubernetes",
      state: "unavailable",
      observedAt,
      reason: typeof status === "number" ? `http_${status}` : "network",
    }
  } finally {
    clearTimeout(timer)
  }
}

// Minimal standalone probe fetch — deliberately not routed through k8s-client.ts's
// `listBounded` (which caches namespaces on success via getNamespaces() callers and has no
// probe-timeout knob of its own); a health probe must never populate or extend a cache entry
// on a stale/failed read (#47 AC: "cache responses ... must not silently extend validity after
// upstream failure"). `signal` is forwarded to both fetch calls so probeK8sDependency's abort
// on timeout actually cancels whichever one is in flight.
async function k8sProbeFetch(signal: AbortSignal): Promise<void> {
  const apiServer = getK8sApiServer()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiServer.startsWith("https://")) {
    const token = getK8sBearerToken()
    if (token.length > 0) headers.Authorization = `Bearer ${token}`
  }
  let res = await fetch(`${apiServer}/api/v1/namespaces?limit=1`, { headers, signal })
  if (res.status === 401) {
    invalidateK8sBearerToken()
    const token = getK8sBearerToken()
    res = await fetch(`${apiServer}/api/v1/namespaces?limit=1`, {
      headers: token.length > 0 ? { ...headers, Authorization: `Bearer ${token}` } : headers,
      signal,
    })
  }
  if (!res.ok) {
    const err = new Error(`K8s API ${res.status}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
}

/**
 * Cheap reachability probe for Valkey, via the existing ping-based check (mirrors
 * /api/health/status's `probeValkey`). No separate timeout race here: `getValkey()`'s client is
 * constructed with `commandTimeout: 500` (see valkey.ts), which already bounds every command —
 * including this `ping()` — to reject after 500ms regardless of what `opts.timeoutMs` says, so
 * a second timer here would only ever fire after ioredis has already rejected and would be
 * pure dead weight (an extra pending timeout with nothing left to race). "unconfigured" state
 * maps to "unavailable" (same as `fromProbeState`) since callers are never expecting to
 * distinguish the two here.
 */
export async function probeValkeyDependency(): Promise<DependencyStatus> {
  const observedAt = nowIso()
  if (!process.env.VALKEY_URL && !process.env.VALKEY_PASSWORD) {
    return { dependency: "valkey", state: "unavailable", observedAt, reason: "unconfigured" }
  }
  try {
    const pong = await getValkey().ping()
    return { dependency: "valkey", state: pong === "PONG" ? "ok" : "partial", observedAt }
  } catch {
    return { dependency: "valkey", state: "unavailable", observedAt, reason: "timeout_or_network" }
  }
}

export interface DependencyHealthSnapshot {
  observedAt: string
  dependencies: DependencyStatus[]
}

const SNAPSHOT_CACHE_TTL_SECONDS = 10

// In-process request coalescing: while a snapshot run is in flight, every concurrent caller
// awaits the SAME promise instead of triggering its own fan-out of 6 probes. Cleared as soon as
// the run settles (success or failure) so the next call after that always re-probes rather than
// reusing a stale in-memory reference — the cross-request freshness guarantee comes from the
// Valkey cache below, not from this variable living longer than one run.
let inFlightSnapshot: Promise<DependencyHealthSnapshot> | null = null

async function runDependencyProbes(timeoutMs: number): Promise<DependencyHealthSnapshot> {
  const dependencies = await Promise.all([
    probeHttpDependency("prometheus", process.env.PROMETHEUS_URL, { timeoutMs }),
    probeK8sDependency({ timeoutMs }),
    probeHttpDependency("argocd", process.env.ARGOCD_URL, { timeoutMs }),
    probeHttpDependency("gitea", process.env.GITEA_URL, { timeoutMs }),
    probeHttpDependency("keycloak", process.env.KEYCLOAK_ISSUER, { timeoutMs }),
    probeValkeyDependency(),
  ])
  return { observedAt: nowIso(), dependencies }
}

/**
 * Entry point for /api/health/dependencies: returns a coalesced, short-TTL-cached snapshot of
 * every core dependency instead of re-probing on every single request.
 *
 * - Coalescing: N concurrent callers while a run is in flight share that one run (see
 *   `inFlightSnapshot` above) instead of each fanning out their own 6 probes — an authenticated
 *   caller (or several) hitting this endpoint repeatedly can no longer multiply into an
 *   amplification vector against every upstream dependency at once.
 * - Caching: a snapshot is written to Valkey for {@link SNAPSHOT_CACHE_TTL_SECONDS} ONLY when
 *   every dependency's state is "ok" — matching this repo's project-wide cache-keys.ts rule that
 *   no namespace ever caches a partial/failed provider response (see
 *   cache-keys.contract.test.ts's "no namespace caches a partial/failed provider response by
 *   default"), and #47's AC that a degraded dependency must never be masked by a stale cached
 *   snapshot. A run with ANY non-"ok" state (partial/stale/empty/unavailable/unauthorized) is
 *   always re-probed on the next call, never served stale.
 */
export async function getDependencyHealthSnapshot(
  opts: { timeoutMs?: number } = {}
): Promise<DependencyHealthSnapshot> {
  const cached = await cacheGet<DependencyHealthSnapshot>(cacheKeys.healthDependencies())
  if (cached) return cached

  if (inFlightSnapshot) return inFlightSnapshot

  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const run = runDependencyProbes(timeoutMs).finally(() => {
    inFlightSnapshot = null
  })
  inFlightSnapshot = run

  const snapshot = await run
  if (snapshot.dependencies.every((d) => d.state === "ok")) {
    await cacheSet(cacheKeys.healthDependencies(), snapshot, SNAPSHOT_CACHE_TTL_SECONDS)
  }
  return snapshot
}
