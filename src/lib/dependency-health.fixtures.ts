/**
 * Deterministic offline fixtures for dependency health failure injection and transition sequence (portal#47).
 *
 * Provides deterministic offline test data for:
 *  - AC-6: Representative failure injection covering timeout, 401, 403, 5xx, stale cache,
 *    and partial provider responses (mixed states).
 *  - AC-7: Lifecycle transition sequence:
 *    healthy -> degraded (one provider failing) -> unavailable -> recovered
 *    asserting that recovery clears degraded/stale flags.
 */

import type {
  DependencyName,
  DependencyStatus,
  AggregateDependencyHealth,
} from "./dependency-health"

export const FIXTURE_BASE_TIME = "2026-09-28T12:00:00.000Z"
export const FIXTURE_T1_HEALTHY = "2026-09-28T12:00:00.000Z"
export const FIXTURE_T2_DEGRADED = "2026-09-28T12:01:00.000Z"
export const FIXTURE_T3_UNAVAILABLE = "2026-09-28T12:02:00.000Z"
export const FIXTURE_T4_RECOVERED = "2026-09-28T12:03:00.000Z"

export function makeStatus(
  dependency: DependencyName,
  overrides: Partial<DependencyStatus> = {}
): DependencyStatus {
  return {
    dependency,
    state: "ok",
    observedAt: FIXTURE_BASE_TIME,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC-7: Four-stage lifecycle transition sequence fixtures
// ---------------------------------------------------------------------------

// Step 1: Healthy — all core and optional dependencies report ok
export const FIXTURE_HEALTHY_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes", { observedAt: FIXTURE_T1_HEALTHY }),
  makeStatus("prometheus", { observedAt: FIXTURE_T1_HEALTHY }),
  makeStatus("valkey", { observedAt: FIXTURE_T1_HEALTHY }),
  makeStatus("argocd", { observedAt: FIXTURE_T1_HEALTHY }),
  makeStatus("gitea", { observedAt: FIXTURE_T1_HEALTHY }),
  makeStatus("keycloak", { observedAt: FIXTURE_T1_HEALTHY }),
]

// Step 2: Degraded — one provider failing (argocd timeout) and prometheus served from stale cache
export const FIXTURE_DEGRADED_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes", { observedAt: FIXTURE_T2_DEGRADED }),
  makeStatus("prometheus", {
    state: "stale",
    observedAt: "2026-09-28T11:50:00.000Z",
    freshnessSeconds: 660,
    reason: "cache_stale",
  }),
  makeStatus("valkey", { observedAt: FIXTURE_T2_DEGRADED }),
  makeStatus("argocd", {
    state: "unavailable",
    observedAt: FIXTURE_T2_DEGRADED,
    reason: "timeout",
    detail: "https://argocd.narwhal.internal/api/v1/version",
  }),
  makeStatus("gitea", { observedAt: FIXTURE_T2_DEGRADED }),
  makeStatus("keycloak", { observedAt: FIXTURE_T2_DEGRADED }),
]

// Step 3: Unavailable — core dependency failure (kubernetes network down, prometheus timeout)
export const FIXTURE_UNAVAILABLE_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes", {
    state: "unavailable",
    observedAt: FIXTURE_T3_UNAVAILABLE,
    reason: "network",
    detail: "ECONNREFUSED",
  }),
  makeStatus("prometheus", {
    state: "unavailable",
    observedAt: FIXTURE_T3_UNAVAILABLE,
    reason: "timeout",
    detail: "https://prometheus.narwhal.internal/api/v1/query",
  }),
  makeStatus("valkey", { observedAt: FIXTURE_T3_UNAVAILABLE }),
  makeStatus("argocd", {
    state: "unavailable",
    observedAt: FIXTURE_T3_UNAVAILABLE,
    reason: "timeout",
    detail: "https://argocd.narwhal.internal/api/v1/version",
  }),
  makeStatus("gitea", { observedAt: FIXTURE_T3_UNAVAILABLE }),
  makeStatus("keycloak", { observedAt: FIXTURE_T3_UNAVAILABLE }),
]

// Step 4: Recovered — full recovery, clearing all degraded, stale, and error flags
export const FIXTURE_RECOVERED_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes", { observedAt: FIXTURE_T4_RECOVERED }),
  makeStatus("prometheus", { observedAt: FIXTURE_T4_RECOVERED }),
  makeStatus("valkey", { observedAt: FIXTURE_T4_RECOVERED }),
  makeStatus("argocd", { observedAt: FIXTURE_T4_RECOVERED }),
  makeStatus("gitea", { observedAt: FIXTURE_T4_RECOVERED }),
  makeStatus("keycloak", { observedAt: FIXTURE_T4_RECOVERED }),
]

export interface TransitionStepFixture {
  readonly name: "healthy" | "degraded" | "unavailable" | "recovered"
  readonly observedAt: string
  readonly dependencies: readonly DependencyStatus[]
  readonly expectedAggregate: AggregateDependencyHealth
}

export const FIXTURE_TRANSITION_SEQUENCE: readonly TransitionStepFixture[] = [
  {
    name: "healthy",
    observedAt: FIXTURE_T1_HEALTHY,
    dependencies: FIXTURE_HEALTHY_DEPENDENCIES,
    expectedAggregate: { state: "ok", observedAt: FIXTURE_T1_HEALTHY },
  },
  {
    name: "degraded",
    observedAt: FIXTURE_T2_DEGRADED,
    dependencies: FIXTURE_DEGRADED_DEPENDENCIES,
    expectedAggregate: { state: "degraded", observedAt: FIXTURE_T2_DEGRADED },
  },
  {
    name: "unavailable",
    observedAt: FIXTURE_T3_UNAVAILABLE,
    dependencies: FIXTURE_UNAVAILABLE_DEPENDENCIES,
    expectedAggregate: { state: "unavailable", observedAt: FIXTURE_T3_UNAVAILABLE },
  },
  {
    name: "recovered",
    observedAt: FIXTURE_T4_RECOVERED,
    dependencies: FIXTURE_RECOVERED_DEPENDENCIES,
    expectedAggregate: { state: "ok", observedAt: FIXTURE_T4_RECOVERED },
  },
]

// ---------------------------------------------------------------------------
// AC-6: Representative failure injection status fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_TIMEOUT_CORE: DependencyStatus = {
  dependency: "prometheus",
  state: "unavailable",
  observedAt: FIXTURE_BASE_TIME,
  reason: "timeout",
  detail: "https://prometheus.narwhal.internal/api/v1/query",
}

export const FIXTURE_TIMEOUT_OPTIONAL: DependencyStatus = {
  dependency: "argocd",
  state: "unavailable",
  observedAt: FIXTURE_BASE_TIME,
  reason: "timeout",
  detail: "https://argocd.narwhal.internal/api/v1/version",
}

export const FIXTURE_401_CORE: DependencyStatus = {
  dependency: "kubernetes",
  state: "unauthorized",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_401",
}

export const FIXTURE_401_OPTIONAL: DependencyStatus = {
  dependency: "keycloak",
  state: "unauthorized",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_401",
}

export const FIXTURE_403_CORE: DependencyStatus = {
  dependency: "kubernetes",
  state: "unauthorized",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_403",
}

export const FIXTURE_403_OPTIONAL: DependencyStatus = {
  dependency: "gitea",
  state: "unauthorized",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_403",
}

export const FIXTURE_5XX_CORE_K8S: DependencyStatus = {
  dependency: "kubernetes",
  state: "unavailable",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_500",
}

export const FIXTURE_5XX_CORE_PROM: DependencyStatus = {
  dependency: "prometheus",
  state: "partial",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_503",
}

export const FIXTURE_5XX_OPTIONAL: DependencyStatus = {
  dependency: "argocd",
  state: "partial",
  observedAt: FIXTURE_BASE_TIME,
  reason: "http_502",
}

export const FIXTURE_STALE_CACHE: DependencyStatus = {
  dependency: "prometheus",
  state: "stale",
  observedAt: "2026-09-28T11:00:00.000Z",
  freshnessSeconds: 3600,
  reason: "cache_stale",
}

export const FIXTURE_PARTIAL_MIXED_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes"),
  makeStatus("prometheus", { state: "partial", reason: "http_503" }),
  makeStatus("valkey"),
  makeStatus("argocd", {
    state: "unavailable",
    reason: "timeout",
    detail: "https://argocd.narwhal.internal/api/v1/version",
  }),
  makeStatus("gitea", { state: "unauthorized", reason: "http_401" }),
  makeStatus("keycloak"),
]
