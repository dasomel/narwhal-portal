import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { cacheKeys } from "./cache-keys"
import {
  aggregateDependencyHealth,
  probeHttpDependency,
  probeK8sDependency,
  getDependencyHealthSnapshot,
  getDependencyHealthSummary,
  type DependencyHealthSnapshot,
} from "./dependency-health"
import {
  fakeCacheStore,
  resetHealthTestMocks,
  mockCacheGetWithMeta,
  FIXTURE_TIMEOUT_CORE,
  FIXTURE_TIMEOUT_OPTIONAL,
  FIXTURE_403_CORE,
  FIXTURE_403_OPTIONAL,
  FIXTURE_5XX_CORE_K8S,
  FIXTURE_5XX_CORE_PROM,
  FIXTURE_5XX_OPTIONAL,
  FIXTURE_STALE_CACHE,
  FIXTURE_PARTIAL_MIXED_DEPENDENCIES,
  makeStatus,
} from "./dependency-health.fixtures"

vi.mock("./config", async () => {
  const { mockGetK8sApiServer } = await import("./dependency-health.fixtures")
  return {
    getK8sApiServer: () => mockGetK8sApiServer(),
    getDependencyUrl: (_env: string, fallback: string) => fallback,
    isProduction: () => false,
  }
})

vi.mock("./k8s-token", async () => {
  const { mockGetK8sBearerToken, mockInvalidateK8sBearerToken } = await import("./dependency-health.fixtures")
  return {
    getK8sBearerToken: () => mockGetK8sBearerToken(),
    invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
  }
})

vi.mock("./valkey", async () => {
  const { mockPing, mockCacheGet, mockCacheGetWithMeta, mockCacheSet } = await import("./dependency-health.fixtures")
  return {
    getValkey: () => ({ ping: () => mockPing() }),
    cacheGet: (key: string) => mockCacheGet(key),
    cacheGetWithMeta: (key: string) => mockCacheGetWithMeta(key),
    cacheSet: (key: string, value: unknown, ttl: number) => mockCacheSet(key, value, ttl),
  }
})

vi.mock("./live-stream", async () => {
  const { mockLiveStreamStatus } = await import("./dependency-health.fixtures")
  return {
    getLiveStreamStatus: () => mockLiveStreamStatus(),
  }
})

describe("AC-6 Domain failure injection (portal#47)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    resetHealthTestMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe("Probe-level failure mapping (genuinely new cases)", () => {
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

    it("projects 401 failure: core causes unavailable, optional causes degraded, names source in admin view and absent from non-admin summary", async () => {
      // 1. Optional dependency 401 failure (keycloak unauthorized)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("keycloak")) return Promise.resolve({ ok: false, status: 401 } as Response)
          if (url.includes("namespaces")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ items: [] }),
            } as unknown as Response)
          }
          return Promise.resolve({ ok: true, status: 200 } as Response)
        })
      )

      // Admin snapshot path: getDependencyHealthSnapshot (used by GET /api/health/dependencies)
      const adminSnapshotOptional = await getDependencyHealthSnapshot()
      const keycloakStatus = adminSnapshotOptional.dependencies.find((d) => d.dependency === "keycloak")
      expect(keycloakStatus).toMatchObject({
        dependency: "keycloak",
        state: "unauthorized",
        reason: "http_401",
      })

      // Non-admin summary path: getDependencyHealthSummary (used by GET /api/health/summary)
      const nonAdminSummaryOptional = await getDependencyHealthSummary()
      expect(nonAdminSummaryOptional.state).toBe("degraded")
      expect(nonAdminSummaryOptional).not.toHaveProperty("dependencies")
      expect(JSON.stringify(nonAdminSummaryOptional)).not.toContain("keycloak")
      expect(Object.keys(nonAdminSummaryOptional).sort()).toEqual(["observedAt", "state"])

      // 2. Core dependency 401 failure (kubernetes unauthorized)
      resetHealthTestMocks()

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("namespaces")) return Promise.resolve({ ok: false, status: 401 } as Response)
          return Promise.resolve({ ok: true, status: 200 } as Response)
        })
      )

      const adminSnapshotCore = await getDependencyHealthSnapshot()
      const k8sStatus = adminSnapshotCore.dependencies.find((d) => d.dependency === "kubernetes")
      expect(k8sStatus).toMatchObject({
        dependency: "kubernetes",
        state: "unauthorized",
        reason: "http_401",
      })

      const nonAdminSummaryCore = await getDependencyHealthSummary()
      expect(nonAdminSummaryCore.state).toBe("unavailable")
      expect(nonAdminSummaryCore).not.toHaveProperty("dependencies")
      expect(JSON.stringify(nonAdminSummaryCore)).not.toContain("kubernetes")
      expect(Object.keys(nonAdminSummaryCore).sort()).toEqual(["observedAt", "state"])
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

    it("projects stale cache: preserves cachedAt/freshnessSeconds in admin view and marks aggregate degraded, absent from non-admin summary", async () => {
      const staleSnapshot: DependencyHealthSnapshot = {
        observedAt: FIXTURE_STALE_CACHE.observedAt,
        dependencies: [
          makeStatus("kubernetes", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
          FIXTURE_STALE_CACHE,
          makeStatus("valkey", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
          makeStatus("argocd", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
          makeStatus("gitea", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
          makeStatus("keycloak", { observedAt: FIXTURE_STALE_CACHE.observedAt }),
        ],
      }

      fakeCacheStore.set(cacheKeys.healthDependencies(), {
        value: staleSnapshot,
        cachedAt: FIXTURE_STALE_CACHE.observedAt,
        expiresAt: Date.now() + 60_000,
      })

      // 1. Real admin snapshot path (getDependencyHealthSnapshot, used by /api/health/dependencies)
      const adminSnapshot = await getDependencyHealthSnapshot()
      const promDep = adminSnapshot.dependencies.find((d) => d.dependency === "prometheus")
      expect(promDep).toMatchObject({
        dependency: "prometheus",
        state: "stale",
        reason: "cache_stale",
        freshnessSeconds: 3600,
      })
      expect(promDep?.freshnessSeconds).toBe(3600)
      expect(adminSnapshot.dependencies.map((d) => d.dependency)).toContain("prometheus")

      const cachedMeta = (await mockCacheGetWithMeta(
        cacheKeys.healthDependencies()
      )) as { value: DependencyHealthSnapshot; cachedAt: string; ageSeconds: number } | null
      expect(cachedMeta).not.toBeNull()
      expect(cachedMeta?.cachedAt).toBe(FIXTURE_STALE_CACHE.observedAt)
      const cachedProm = cachedMeta?.value.dependencies.find((d) => d.dependency === "prometheus")
      expect(cachedProm?.freshnessSeconds).toBe(3600)
      expect(cachedProm?.state).toBe("stale")

      // 3. Non-admin summary path: marks aggregate degraded, source absent from summary
      const nonAdminSummary = await getDependencyHealthSummary()
      expect(nonAdminSummary.state).toBe("degraded")
      expect(nonAdminSummary).not.toHaveProperty("dependencies")
      expect(JSON.stringify(nonAdminSummary)).not.toContain("prometheus")
      expect(Object.keys(nonAdminSummary).sort()).toEqual(["observedAt", "state"])
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
          if (url.includes("namespaces")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ items: [] }),
            } as unknown as Response)
          }
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
    })

    it("verifies fixture mixed responses never project failure as healthy/zero-success", () => {
      const agg = aggregateDependencyHealth(FIXTURE_PARTIAL_MIXED_DEPENDENCIES)
      expect(agg.state).not.toBe("ok")
      expect(agg.state).toBe("degraded")
    })
  })
})
