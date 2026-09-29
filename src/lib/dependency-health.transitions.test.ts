import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { cacheKeys } from "./cache-keys"
import {
  aggregateDependencyHealth,
  getDependencyHealthSnapshot,
} from "./dependency-health"
import { FIXTURE_TRANSITION_SEQUENCE } from "./dependency-health.fixtures"
import {
  resetHealthTestMocks,
  setupProbesForStep,
  mockCacheGetWithMeta,
} from "./dependency-health.test-helpers"

vi.mock("./config", async () => {
  const { mockGetK8sApiServer } = await import("./dependency-health.test-helpers")
  return {
    getK8sApiServer: () => mockGetK8sApiServer(),
    getDependencyUrl: (_env: string, fallback: string) => fallback,
    isProduction: () => false,
  }
})

vi.mock("./k8s-token", async () => {
  const { mockGetK8sBearerToken, mockInvalidateK8sBearerToken } = await import("./dependency-health.test-helpers")
  return {
    getK8sBearerToken: () => mockGetK8sBearerToken(),
    invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
  }
})

vi.mock("./valkey", async () => {
  const { mockPing, mockCacheGet, mockCacheGetWithMeta, mockCacheSet } = await import("./dependency-health.test-helpers")
  return {
    getValkey: () => ({ ping: () => mockPing() }),
    cacheGet: (key: string) => mockCacheGet(key),
    cacheGetWithMeta: (key: string) => mockCacheGetWithMeta(key),
    cacheSet: (key: string, value: unknown, ttl: number) => mockCacheSet(key, value, ttl),
  }
})

vi.mock("./live-stream", async () => {
  const { mockLiveStreamStatus } = await import("./dependency-health.test-helpers")
  return {
    getLiveStreamStatus: () => mockLiveStreamStatus(),
  }
})

describe("AC-7 Offline lifecycle transition replay (portal#47)", () => {
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

  it("replays sequence healthy -> degraded -> unavailable -> recovered through aggregateDependencyHealth", () => {
    for (const step of FIXTURE_TRANSITION_SEQUENCE) {
      const agg = aggregateDependencyHealth(step.dependencies)
      expect(agg.state).toBe(step.expectedAggregate.state)
      expect(agg.observedAt).toBe(step.expectedAggregate.observedAt)
    }
  })

  it("replays transitions deterministically through snapshot and summary without network or wall-clock timers", async () => {
    vi.useFakeTimers()
    resetHealthTestMocks()

    // Step 1: Healthy
    const step1 = FIXTURE_TRANSITION_SEQUENCE.find((s) => s.name === "healthy")!
    setupProbesForStep(step1.dependencies)

    const snap1Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap1 = await snap1Promise

    expect(snap1.dependencies.every((d) => d.state === "ok")).toBe(true)
    for (const dep of snap1.dependencies) {
      expect(dep.reason).toBeUndefined()
    }
    const sum1 = aggregateDependencyHealth(snap1.dependencies)
    expect(sum1.state).toBe("ok")

    // Real cache read with metadata: healthy snapshot was cached in Valkey
    const cachedMeta1 = await mockCacheGetWithMeta(cacheKeys.healthDependencies())
    expect(cachedMeta1?.cachedAt).toBeDefined()
    expect(cachedMeta1?.ageSeconds).toBeCloseTo(0.1, 1)

    // Advance fake time past snapshot cache TTL (10s) without manually clearing cache
    await vi.advanceTimersByTimeAsync(11_000)

    // Step 2: Degraded (ArgoCD times out)
    const step2 = FIXTURE_TRANSITION_SEQUENCE.find((s) => s.name === "degraded")!
    setupProbesForStep(step2.dependencies)

    const snap2Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap2 = await snap2Promise

    const argoDep = snap2.dependencies.find((d) => d.dependency === "argocd")
    expect(argoDep?.state).toBe("unavailable")
    expect(argoDep?.reason).toBe("timeout")

    const sum2 = aggregateDependencyHealth(snap2.dependencies)
    expect(sum2.state).toBe("degraded")

    // Rely on success-only caching rule: degraded snapshot is NOT cached
    const cachedMeta2 = await mockCacheGetWithMeta(cacheKeys.healthDependencies())
    expect(cachedMeta2).toBeNull()

    // Step 3: Unavailable (Kubernetes network down, Prometheus times out)
    const step3 = FIXTURE_TRANSITION_SEQUENCE.find((s) => s.name === "unavailable")!
    setupProbesForStep(step3.dependencies)

    const snap3Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap3 = await snap3Promise

    const k8sDep = snap3.dependencies.find((d) => d.dependency === "kubernetes")
    expect(k8sDep?.state).toBe("unavailable")
    expect(k8sDep?.reason).toBe("network")

    const promDep = snap3.dependencies.find((d) => d.dependency === "prometheus")
    expect(promDep?.state).toBe("unavailable")
    expect(promDep?.reason).toBe("timeout")

    const sum3 = aggregateDependencyHealth(snap3.dependencies)
    expect(sum3.state).toBe("unavailable")

    // Unavailable snapshot is also NOT cached
    expect(await mockCacheGetWithMeta(cacheKeys.healthDependencies())).toBeNull()

    // Step 4: Recovered (all healthy again)
    const step4 = FIXTURE_TRANSITION_SEQUENCE.find((s) => s.name === "recovered")!
    setupProbesForStep(step4.dependencies)

    const snap4Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap4 = await snap4Promise

    // Real output verification: recovery transition clears all degraded/stale flags
    expect(snap4.dependencies.every((d) => d.state === "ok")).toBe(true)
    for (const dep of snap4.dependencies) {
      expect(dep.state).toBe("ok")
      expect(dep.reason).toBeUndefined()
      expect(dep.freshnessSeconds).toBeUndefined()
      expect(dep.detail).toBeUndefined()
    }

    const sum4 = aggregateDependencyHealth(snap4.dependencies)
    expect(sum4.state).toBe("ok")

    // Recovered healthy snapshot is cached again
    const cachedMeta4 = await mockCacheGetWithMeta(cacheKeys.healthDependencies())
    expect(cachedMeta4).not.toBeNull()
    expect(cachedMeta4?.cachedAt).toBeDefined()
  })
})
