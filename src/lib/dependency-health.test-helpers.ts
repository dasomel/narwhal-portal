/**
 * Vitest mock state and setup helpers for dependency health failure injection
 * and transition sequence tests (portal#47).
 *
 * Split out of dependency-health.fixtures.ts so that file stays pure fixture
 * data (no vitest dependency), mirroring the src/lib/domain/cluster.fixtures.ts
 * precedent. This file may depend on vitest and on the pure fixtures.
 */

import { vi } from "vitest"
import type { DependencyName, DependencyStatus } from "./dependency-health"
import { HttpClientError } from "./http-client"

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
