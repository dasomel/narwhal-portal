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
import { getValkey } from "./valkey"
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
   * http-client.ts's `redactUrl`). Still identifies the dependency's hostname, so callers
   * MUST strip this field before returning a response to a non-admin caller; see
   * /api/health/dependencies's route for the redaction boundary.
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
 * Cheap reachability probe for the in-cluster Kubernetes API: a single-item, single-page
 * `listBounded` read against `/api/v1/namespaces`. Deliberately ignores the result's own
 * `truncated` flag — that signal is about list *completeness*, not API reachability, and a
 * healthy multi-namespace cluster will always report truncated=true at limit=1/maxPages=1.
 * Bounded by a race against `timeoutMs` the same way ready/route.ts's Valkey probe is, since
 * the underlying fetch has no AbortController wired through listBounded.
 */
export async function probeK8sDependency(opts: { timeoutMs?: number } = {}): Promise<DependencyStatus> {
  const observedAt = nowIso()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  try {
    await Promise.race([
      k8sProbeFetch(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ])
    return { dependency: "kubernetes", state: "ok", observedAt }
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status
    if (status === 401 || status === 403) {
      return { dependency: "kubernetes", state: "unauthorized", observedAt, reason: `http_${status}` }
    }
    return {
      dependency: "kubernetes",
      state: "unavailable",
      observedAt,
      reason: typeof status === "number" ? `http_${status}` : "timeout_or_network",
    }
  }
}

// Minimal standalone probe fetch — deliberately not routed through k8s-client.ts's
// `listBounded` (which caches namespaces on success via getNamespaces() callers and has no
// probe-timeout knob of its own); a health probe must never populate or extend a cache entry
// on a stale/failed read (#47 AC: "cache responses ... must not silently extend validity after
// upstream failure").
async function k8sProbeFetch(): Promise<void> {
  const apiServer = getK8sApiServer()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiServer.startsWith("https://")) {
    const token = getK8sBearerToken()
    if (token.length > 0) headers.Authorization = `Bearer ${token}`
  }
  let res = await fetch(`${apiServer}/api/v1/namespaces?limit=1`, { headers })
  if (res.status === 401) {
    invalidateK8sBearerToken()
    const token = getK8sBearerToken()
    res = await fetch(`${apiServer}/api/v1/namespaces?limit=1`, {
      headers: token.length > 0 ? { ...headers, Authorization: `Bearer ${token}` } : headers,
    })
  }
  if (!res.ok) {
    const err = new Error(`K8s API ${res.status}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
}

/**
 * Cheap bounded-timeout reachability probe for Valkey, via the existing ping-based check
 * (mirrors /api/health/status's `probeValkey`). "unconfigured" state maps to "unavailable"
 * (same as `fromProbeState`) since callers are never expecting to distinguish the two here.
 */
export async function probeValkeyDependency(opts: { timeoutMs?: number } = {}): Promise<DependencyStatus> {
  const observedAt = nowIso()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  if (!process.env.VALKEY_URL && !process.env.VALKEY_PASSWORD) {
    return { dependency: "valkey", state: "unavailable", observedAt, reason: "unconfigured" }
  }
  try {
    const client = getValkey()
    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ])
    return { dependency: "valkey", state: pong === "PONG" ? "ok" : "partial", observedAt }
  } catch {
    return { dependency: "valkey", state: "unavailable", observedAt, reason: "timeout_or_network" }
  }
}
