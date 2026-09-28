/**
 * Deterministic offline fixtures and mock setup for dependency health failure injection and transition sequence (portal#47).
 *
 * Provides deterministic offline test data and shared mock helpers for:
 *  - AC-6: Representative failure injection covering timeout, 401, 403, 5xx, stale cache,
 *    and partial provider responses (mixed states).
 *  - AC-7: Lifecycle transition sequence:
 *    healthy -> degraded (one provider failing) -> unavailable -> recovered
 *    asserting that recovery clears degraded/stale flags.
 */

import { vi } from "vitest"
import type {
  DependencyName,
  DependencyStatus,
  AggregateDependencyHealth,
} from "./dependency-health"
import { HttpClientError } from "./http-client"

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

// Step 2: Degraded — one optional provider failing (argocd timeout)
export const FIXTURE_DEGRADED_DEPENDENCIES: readonly DependencyStatus[] = [
  makeStatus("kubernetes", { observedAt: FIXTURE_T2_DEGRADED }),
  makeStatus("prometheus", { observedAt: FIXTURE_T2_DEGRADED }),
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

// ---------------------------------------------------------------------------
// Shared mock state & setup helpers (portal#47 review fix)
// ---------------------------------------------------------------------------

export interface FakeCacheEntry {
  value: unknown
  cachedAt: string
  expiresAt: number
}

export const fakeCacheStore = new Map<string, FakeCacheEntry>()

export const mockCacheGet = vi.fn(async (key: string) => {
  const entry = fakeCacheStore.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    fakeCacheStore.delete(key)
    return null
  }
  return entry.value
})

export const mockCacheGetWithMeta = vi.fn(async <T>(key: string) => {
  const entry = fakeCacheStore.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    fakeCacheStore.delete(key)
    return null
  }
  return {
    value: entry.value as T,
    cachedAt: entry.cachedAt,
    ageSeconds: Math.max(0, (Date.now() - Date.parse(entry.cachedAt)) / 1000),
  }
})

export const mockCacheSet = vi.fn(async (key: string, value: unknown, ttlSeconds: number) => {
  const now = Date.now()
  fakeCacheStore.set(key, {
    value,
    cachedAt: new Date(now).toISOString(),
    expiresAt: now + ttlSeconds * 1000,
  })
})

export const mockPing = vi.fn()
export const mockLiveStreamStatus = vi.fn(
  (): { dependency: "valkey"; state: "ok" | "partial" | "unavailable"; observedAt: string; reason?: string } => ({
    dependency: "valkey",
    state: "ok",
    observedAt: new Date().toISOString(),
  })
)

export const mockGetK8sApiServer = vi.fn(() => "https://kubernetes.default.svc")
export const mockGetK8sBearerToken = vi.fn(() => "test-token")
export const mockInvalidateK8sBearerToken = vi.fn()

export function resetHealthTestMocks() {
  process.env.PROMETHEUS_URL = "https://prometheus.narwhal.internal"
  process.env.ARGOCD_URL = "https://argocd.narwhal.internal"
  process.env.GITEA_URL = "https://gitea.narwhal.internal"
  process.env.KEYCLOAK_ISSUER = "https://keycloak.narwhal.internal"
  process.env.VALKEY_URL = "redis://valkey:6379"

  fakeCacheStore.clear()
  mockCacheGet.mockClear()
  mockCacheGetWithMeta.mockClear()
  mockCacheSet.mockClear()
  mockPing.mockReset()
  mockPing.mockResolvedValue("PONG")
  mockLiveStreamStatus.mockReset()
  mockLiveStreamStatus.mockReturnValue({
    dependency: "valkey",
    state: "ok",
    observedAt: new Date().toISOString(),
  })
}

export function setupProbesForStep(dependencies: readonly DependencyStatus[]) {
  const depMap = new Map(dependencies.map((d) => [d.dependency, d]))

  const valkeyStatus = depMap.get("valkey")
  if (valkeyStatus) {
    if (valkeyStatus.state === "unavailable") {
      mockPing.mockRejectedValue(new Error("connection closed"))
    } else {
      mockPing.mockResolvedValue("PONG")
      if (valkeyStatus.state === "partial") {
        mockLiveStreamStatus.mockReturnValue({
          dependency: "valkey",
          state: "partial",
          observedAt: new Date().toISOString(),
          reason: valkeyStatus.reason || "persistence_failure",
        })
      } else {
        mockLiveStreamStatus.mockReturnValue({
          dependency: "valkey",
          state: "ok",
          observedAt: new Date().toISOString(),
        })
      }
    }
  }

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      let depName: DependencyName | null = null
      if (url.includes("namespaces")) depName = "kubernetes"
      else if (url.includes("prometheus")) depName = "prometheus"
      else if (url.includes("argocd")) depName = "argocd"
      else if (url.includes("gitea")) depName = "gitea"
      else if (url.includes("keycloak")) depName = "keycloak"

      const status = depName ? depMap.get(depName) : undefined
      if (!status || status.state === "ok") {
        if (depName === "kubernetes") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ items: [] }),
          } as unknown as Response)
        }
        return Promise.resolve({ ok: true, status: 200 } as Response)
      }

      if (status.state === "unauthorized") {
        const httpStatus = status.reason === "http_403" ? 403 : 401
        return Promise.resolve({ ok: false, status: httpStatus } as Response)
      }

      if (status.state === "partial") {
        const httpStatus = status.reason?.startsWith("http_")
          ? Number(status.reason.replace("http_", ""))
          : 503
        return Promise.resolve({ ok: false, status: httpStatus } as Response)
      }

      if (status.state === "unavailable") {
        if (status.reason === "timeout") {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              if (depName === "kubernetes") {
                reject(new DOMException("Aborted", "AbortError"))
              } else {
                reject(new HttpClientError("timeout", url))
              }
            })
          })
        }
        if (status.reason === "http_500") {
          return Promise.resolve({ ok: false, status: 500 } as Response)
        }
        return Promise.reject(new Error(status.detail || "ECONNREFUSED"))
      }

      return Promise.resolve({ ok: true, status: 200 } as Response)
    })
  )
}
