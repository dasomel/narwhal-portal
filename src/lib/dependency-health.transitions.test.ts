import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HttpClientError } from "./http-client"

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
  getDependencyHealthSnapshot,
} from "./dependency-health"
import { FIXTURE_TRANSITION_SEQUENCE } from "./dependency-health.fixtures"

describe("AC-7 Offline lifecycle transition replay (portal#47)", () => {
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

  it("replays sequence healthy -> degraded -> unavailable -> recovered through aggregateDependencyHealth", () => {
    for (const step of FIXTURE_TRANSITION_SEQUENCE) {
      const agg = aggregateDependencyHealth(step.dependencies)
      expect(agg.state).toBe(step.expectedAggregate.state)
      expect(agg.observedAt).toBe(step.expectedAggregate.observedAt)
    }

    // Recovery transition clears all degraded/stale flags
    const recoveredStep = FIXTURE_TRANSITION_SEQUENCE.find((s) => s.name === "recovered")!
    for (const dep of recoveredStep.dependencies) {
      expect(dep.state).toBe("ok")
      expect(dep.reason).toBeUndefined()
      expect(dep.freshnessSeconds).toBeUndefined()
      expect(dep.detail).toBeUndefined()
    }
  })

  it("replays transitions deterministically through snapshot and summary without network or wall-clock timers", async () => {
    vi.useFakeTimers()
    fakeCacheStore.clear()
    mockCacheGet.mockClear()
    mockCacheSet.mockClear()
    mockPing.mockReset()
    mockPing.mockResolvedValue("PONG")

    // Stage 1: Healthy
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
    const snap1Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap1 = await snap1Promise
    expect(snap1.dependencies.every((d) => d.state === "ok")).toBe(true)
    const sum1 = aggregateDependencyHealth(snap1.dependencies)
    expect(sum1.state).toBe("ok")

    // Stage 2: Degraded (ArgoCD times out)
    fakeCacheStore.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("argocd")) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new HttpClientError("timeout", url))
            })
          })
        }
        return Promise.resolve({ ok: true, status: 200 } as Response)
      })
    )
    const snap2Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap2 = await snap2Promise
    const argoDep = snap2.dependencies.find((d) => d.dependency === "argocd")
    expect(argoDep?.state).toBe("unavailable")
    expect(argoDep?.reason).toBe("timeout")
    const sum2 = aggregateDependencyHealth(snap2.dependencies)
    expect(sum2.state).toBe("degraded")

    // Stage 3: Unavailable (Kubernetes network down)
    fakeCacheStore.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("namespaces")) return Promise.reject(new Error("ECONNREFUSED"))
        return Promise.resolve({ ok: true, status: 200 } as Response)
      })
    )
    const snap3Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap3 = await snap3Promise
    const k8sDep = snap3.dependencies.find((d) => d.dependency === "kubernetes")
    expect(k8sDep?.state).toBe("unavailable")
    const sum3 = aggregateDependencyHealth(snap3.dependencies)
    expect(sum3.state).toBe("unavailable")

    // Stage 4: Recovered (all healthy again)
    fakeCacheStore.clear()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
    const snap4Promise = getDependencyHealthSnapshot({ timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const snap4 = await snap4Promise
    expect(snap4.dependencies.every((d) => d.state === "ok")).toBe(true)
    for (const dep of snap4.dependencies) {
      expect(dep.reason).toBeUndefined()
    }
    const sum4 = aggregateDependencyHealth(snap4.dependencies)
    expect(sum4.state).toBe("ok")
  })
})
