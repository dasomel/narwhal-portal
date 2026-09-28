import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockGetK8sApiServer = vi.fn(() => "https://kubernetes.default.svc")
const mockGetK8sBearerToken = vi.fn(() => "test-token")
const mockInvalidateK8sBearerToken = vi.fn()
const mockPing = vi.fn()
const mockLiveStreamStatus = vi.fn(() => ({
  dependency: "valkey" as const,
  state: "ok" as const,
  observedAt: new Date().toISOString(),
}))

const fakeCacheStore = new Map<string, unknown>()
const mockCacheGet = vi.fn(async (key: string) => (fakeCacheStore.has(key) ? fakeCacheStore.get(key) : null))
const mockCacheSet = vi.fn(async (key: string, value: unknown, ttlSeconds: number) => {
  void ttlSeconds
  fakeCacheStore.set(key, value)
})

vi.mock("./config", () => ({
  getK8sApiServer: () => mockGetK8sApiServer(),
  getDependencyUrl: (_env: string, fallback: string) => fallback,
  isProduction: () => false,
}))

vi.mock("./k8s-token", () => ({
  getK8sBearerToken: () => mockGetK8sBearerToken(),
  invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
}))

vi.mock("./valkey", () => ({
  getValkey: () => ({ ping: () => mockPing() }),
  cacheGet: (key: string) => mockCacheGet(key),
  cacheSet: (key: string, value: unknown, ttl: number) => mockCacheSet(key, value, ttl),
}))

vi.mock("./live-stream", () => ({
  getLiveStreamStatus: () => mockLiveStreamStatus(),
}))

import {
  aggregateDependencyHealth,
  probeHttpDependency,
  probeK8sDependency,
  getDependencyHealthSnapshot,
  getDependencyHealthSummary,
} from "./dependency-health"
import {
  FIXTURE_TIMEOUT_CORE,
  FIXTURE_TIMEOUT_OPTIONAL,
  FIXTURE_401_CORE,
  FIXTURE_401_OPTIONAL,
  FIXTURE_403_CORE,
  FIXTURE_403_OPTIONAL,
  FIXTURE_5XX_CORE_K8S,
  FIXTURE_5XX_CORE_PROM,
  FIXTURE_5XX_OPTIONAL,
  FIXTURE_STALE_CACHE,
  FIXTURE_PARTIAL_MIXED_DEPENDENCIES,
  makeStatus,
} from "./dependency-health.fixtures"

describe("AC-6 Domain failure injection (portal#47)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PROMETHEUS_URL: "https://prometheus.narwhal.internal",
      ARGOCD_URL: "https://argocd.narwhal.internal",
      GITEA_URL: "https://gitea.narwhal.internal",
      KEYCLOAK_ISSUER: "https://keycloak.narwhal.internal",
      VALKEY_URL: "redis://valkey:6379",
    }
    fakeCacheStore.clear()
    mockCacheGet.mockClear()
    mockCacheSet.mockClear()
    mockPing.mockReset()
    mockPing.mockResolvedValue("PONG")
    mockLiveStreamStatus.mockReturnValue({
      dependency: "valkey",
      state: "ok",
      observedAt: new Date().toISOString(),
    })
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe("Probe-level failure mapping (missing coverage)", () => {
    it("maps HttpClientError timeout to unavailable with timeout reason in probeHttpDependency", async () => {
      vi.useFakeTimers()
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted")
              err.name = "AbortError"
              reject(err)
            })
          })
        })
      )

      const probePromise = probeHttpDependency("argocd", "https://argocd.narwhal.internal/api/version", { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const result = await probePromise

      expect(result).toMatchObject({
        dependency: "argocd",
        state: "unavailable",
        reason: "timeout",
      })
      expect(result.detail).toContain("argocd.narwhal.internal")
    })

    it("maps HTTP 403 probe response to unauthorized with http_403 reason in probeHttpDependency", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response))

      const result = await probeHttpDependency("gitea", "https://gitea.narwhal.internal")

      expect(result).toMatchObject({
        dependency: "gitea",
        state: "unauthorized",
        reason: "http_403",
      })
    })

    it("maps 403 response from Kubernetes API to unauthorized with http_403 reason in probeK8sDependency", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response))

      const result = await probeK8sDependency()

      expect(result).toMatchObject({
        dependency: "kubernetes",
        state: "unauthorized",
        reason: "http_403",
      })
    })

    it("maps 500 server error from Kubernetes API to unavailable with http_500 reason in probeK8sDependency", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response))

      const result = await probeK8sDependency()

      expect(result).toMatchObject({
        dependency: "kubernetes",
        state: "unavailable",
        reason: "http_500",
      })
    })
  })

  describe("Domain projection & aggregate status per failure mode", () => {
    it("projects timeout failure: core causes unavailable, optional causes degraded, neither is healthy", () => {
      const coreTimeoutAgg = aggregateDependencyHealth([
        FIXTURE_TIMEOUT_CORE,
        makeStatus("kubernetes"),
        makeStatus("valkey"),
      ])
      expect(coreTimeoutAgg.state).toBe("unavailable")

      const optionalTimeoutAgg = aggregateDependencyHealth([
        makeStatus("kubernetes"),
        makeStatus("prometheus"),
        makeStatus("valkey"),
        FIXTURE_TIMEOUT_OPTIONAL,
      ])
      expect(optionalTimeoutAgg.state).toBe("degraded")
    })

    it("projects 401 failure: core causes unavailable, optional causes degraded, names source in admin view", () => {
      const coreAgg = aggregateDependencyHealth([FIXTURE_401_CORE, makeStatus("prometheus"), makeStatus("valkey")])
      expect(coreAgg.state).toBe("unavailable")

      const optionalAgg = aggregateDependencyHealth([
        makeStatus("kubernetes"),
        makeStatus("prometheus"),
        makeStatus("valkey"),
        FIXTURE_401_OPTIONAL,
      ])
      expect(optionalAgg.state).toBe("degraded")
    })

    it("projects 403 failure: core causes unavailable, optional causes degraded without leaking names in aggregate", () => {
      const coreAgg = aggregateDependencyHealth([FIXTURE_403_CORE, makeStatus("prometheus"), makeStatus("valkey")])
      expect(coreAgg.state).toBe("unavailable")

      const optionalAgg = aggregateDependencyHealth([
        makeStatus("kubernetes"),
        makeStatus("prometheus"),
        makeStatus("valkey"),
        FIXTURE_403_OPTIONAL,
      ])
      expect(optionalAgg.state).toBe("degraded")
      expect(Object.keys(optionalAgg).sort()).toEqual(["observedAt", "state"])
    })

    it("projects 5xx failure: k8s 500 causes unavailable, prometheus 503 causes degraded, argocd 502 causes degraded", () => {
      const k8s500Agg = aggregateDependencyHealth([FIXTURE_5XX_CORE_K8S, makeStatus("prometheus"), makeStatus("valkey")])
      expect(k8s500Agg.state).toBe("unavailable")

      const prom503Agg = aggregateDependencyHealth([makeStatus("kubernetes"), FIXTURE_5XX_CORE_PROM, makeStatus("valkey")])
      expect(prom503Agg.state).toBe("degraded")

      const argo502Agg = aggregateDependencyHealth([
        makeStatus("kubernetes"),
        makeStatus("prometheus"),
        makeStatus("valkey"),
        FIXTURE_5XX_OPTIONAL,
      ])
      expect(argo502Agg.state).toBe("degraded")
    })

    it("projects stale cache: preserves cachedAt/freshnessSeconds in admin view and marks aggregate degraded", () => {
      expect(FIXTURE_STALE_CACHE.observedAt).toBe("2026-09-28T11:00:00.000Z")
      expect(FIXTURE_STALE_CACHE.freshnessSeconds).toBe(3600)
      expect(FIXTURE_STALE_CACHE.state).toBe("stale")

      const agg = aggregateDependencyHealth([
        makeStatus("kubernetes", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
        FIXTURE_STALE_CACHE,
        makeStatus("valkey", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
      ])
      expect(agg.state).toBe("degraded")
      expect(agg.observedAt).toBe(FIXTURE_STALE_CACHE.observedAt)
    })

    it("projects partial provider responses: admin snapshot names degraded sources, non-admin exposes only state", async () => {
      vi.useFakeTimers()
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url.includes("prometheus")) return Promise.resolve({ ok: false, status: 503 } as Response)
          if (url.includes("argocd")) {
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const err = new Error("The operation was aborted")
                err.name = "AbortError"
                reject(err)
              })
            })
          }
          if (url.includes("gitea")) return Promise.resolve({ ok: false, status: 401 } as Response)
          return Promise.resolve({ ok: true, status: 200 } as Response)
        })
      )

      const snapshotPromise = getDependencyHealthSnapshot({ timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(200)
      const snapshot = await snapshotPromise

      // Admin view: every degraded dependency is explicitly identified with its state and reason
      const prom = snapshot.dependencies.find((d) => d.dependency === "prometheus")
      const argo = snapshot.dependencies.find((d) => d.dependency === "argocd")
      const gitea = snapshot.dependencies.find((d) => d.dependency === "gitea")
      const k8s = snapshot.dependencies.find((d) => d.dependency === "kubernetes")

      expect(prom).toMatchObject({ dependency: "prometheus", state: "partial", reason: "http_503" })
      expect(argo).toMatchObject({ dependency: "argocd", state: "unavailable", reason: "timeout" })
      expect(gitea).toMatchObject({ dependency: "gitea", state: "unauthorized", reason: "http_401" })
      expect(k8s?.state).toBe("ok")

      // Aggregate: degraded (core k8s/valkey are ok, prometheus is partial)
      const agg = aggregateDependencyHealth(snapshot.dependencies)
      expect(agg.state).toBe("degraded")

      const summaryPromise = getDependencyHealthSummary()
      await vi.advanceTimersByTimeAsync(2000)
      const summary = await summaryPromise
      expect(summary.state).toBe("degraded")
      expect(Object.keys(summary).sort()).toEqual(["observedAt", "state"])

      // Crucial: failures must not be cached in the success-only snapshot cache
      expect(mockCacheSet).not.toHaveBeenCalledWith("health:dependencies", expect.anything(), expect.anything())
    })

    it("verifies fixture mixed responses never project failure as healthy/zero-success", () => {
      const agg = aggregateDependencyHealth(FIXTURE_PARTIAL_MIXED_DEPENDENCIES)
      expect(agg.state).not.toBe("ok")
      expect(agg.state).toBe("degraded")
    })
  })
})
