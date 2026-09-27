import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockGetK8sApiServer = vi.fn(() => "https://kubernetes.default.svc")
const mockGetK8sBearerToken = vi.fn(() => "test-token")
const mockInvalidateK8sBearerToken = vi.fn()
const mockPing = vi.fn()
const mockLiveStreamStatus = vi.fn((): { dependency: "valkey"; state: "ok" | "partial"; observedAt: string; reason?: string } => ({ dependency: "valkey", state: "ok", observedAt: new Date().toISOString() }))

// In-memory stand-in for Valkey's cache, so getDependencyHealthSnapshot's cache read/write can
// be asserted deterministically without a real Redis connection.
const fakeCacheStore = new Map<string, unknown>()
const mockCacheGet = vi.fn(async (key: string) => (fakeCacheStore.has(key) ? fakeCacheStore.get(key) : null))
const mockCacheSet = vi.fn(async (key: string, value: unknown, ttlSeconds: number) => {
  void ttlSeconds // signature parity with the real cacheSet(key, value, ttlSeconds); TTL isn't asserted here
  fakeCacheStore.set(key, value)
})

vi.mock("./config", () => ({
  getK8sApiServer: () => mockGetK8sApiServer(),
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
vi.mock("./live-stream", () => ({ getLiveStreamStatus: () => mockLiveStreamStatus() }))

import {
  fromTelemetryStatus,
  fromProbeState,
  fromBoundedListTruncated,
  SCORECARD_UNAVAILABLE_STATE,
  probeHttpDependency,
  probeK8sDependency,
  probeValkeyDependency,
  getDependencyHealthSnapshot,
  getDependencyHealthSummary,
} from "./dependency-health"

describe("dependency-health vocabulary mapping (portal#47)", () => {
  it("fromTelemetryStatus reuses TelemetryStatus values verbatim except ambiguous", () => {
    expect(fromTelemetryStatus("ok")).toBe("ok")
    expect(fromTelemetryStatus("empty")).toBe("empty")
    expect(fromTelemetryStatus("partial")).toBe("partial")
    expect(fromTelemetryStatus("unavailable")).toBe("unavailable")
    expect(fromTelemetryStatus("stale")).toBe("stale")
    expect(fromTelemetryStatus("ambiguous")).toBe("partial")
  })

  it("fromProbeState maps the /api/health/status vocabulary", () => {
    expect(fromProbeState("healthy")).toBe("ok")
    expect(fromProbeState("degraded")).toBe("partial")
    expect(fromProbeState("unavailable")).toBe("unavailable")
    expect(fromProbeState("unconfigured")).toBe("unavailable")
  })

  it("fromBoundedListTruncated maps listBounded's truncated flag", () => {
    expect(fromBoundedListTruncated(false)).toBe("ok")
    expect(fromBoundedListTruncated(true)).toBe("partial")
  })

  it("scorecard's unavailable CheckResult state maps 1:1 (pass/fail have no dependency-health mapping)", () => {
    expect(SCORECARD_UNAVAILABLE_STATE).toBe("unavailable")
  })
})

describe("probeHttpDependency", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports unavailable with reason 'unconfigured' when no URL is set, without calling fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const result = await probeHttpDependency("argocd", undefined)

    expect(result).toMatchObject({ dependency: "argocd", state: "unavailable", reason: "unconfigured" })
    expect(result.detail).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports ok on a 2xx probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    const result = await probeHttpDependency("argocd", "https://argocd.narwhal.internal")

    expect(result).toMatchObject({ dependency: "argocd", state: "ok" })
    expect(result.reason).toBeUndefined()
  })

  it("reports unauthorized on a 401/403 probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response))

    const result = await probeHttpDependency("gitea", "https://gitea.narwhal.internal")

    expect(result).toMatchObject({ dependency: "gitea", state: "unauthorized", reason: "http_401" })
  })

  it("reports partial on a non-2xx, non-401/403 probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))

    const result = await probeHttpDependency("gitea", "https://gitea.narwhal.internal")

    expect(result).toMatchObject({ dependency: "gitea", state: "partial", reason: "http_503" })
  })

  it("reports unavailable with a redacted (hostname, no query/userinfo) detail on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    const result = await probeHttpDependency("keycloak", "https://keycloak.narwhal.internal/realms/x?secret=abc")

    expect(result.dependency).toBe("keycloak")
    expect(result.state).toBe("unavailable")
    expect(result.reason).toBe("network")
    expect(result.detail).toContain("keycloak.narwhal.internal")
    expect(result.detail).not.toContain("secret=abc")
  })
})

describe("probeK8sDependency", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports ok on a successful namespaces probe, ignoring pagination completeness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response)
    )

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "ok" })
  })

  it("reports unauthorized on a 401 that survives the token-refresh retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response))

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "unauthorized", reason: "http_401" })
    expect(mockInvalidateK8sBearerToken).toHaveBeenCalled()
  })

  it("reports unavailable when the connection is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "unavailable", reason: "network" })
  })

  it("aborts the in-flight fetch (not just races a timer) when the probe exceeds its timeout", async () => {
    // Mimics real fetch's abort contract: the request only settles when its signal fires,
    // proving probeK8sDependency's AbortController is actually wired to the fetch call — a
    // fetch mock that ignores `init.signal` (the previous Promise.race-only version's test)
    // would hang here instead of resolving.
    let abortListenerAttached = false
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            abortListenerAttached = true
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
          })
      )
    )

    const result = await probeK8sDependency({ timeoutMs: 20 })

    expect(abortListenerAttached).toBe(true)
    expect(result).toMatchObject({ dependency: "kubernetes", state: "unavailable", reason: "timeout" })
  })
})

describe("probeValkeyDependency", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("reports unavailable with reason 'unconfigured' when neither VALKEY_URL nor VALKEY_PASSWORD is set", async () => {
    delete process.env.VALKEY_URL
    delete process.env.VALKEY_PASSWORD

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "unavailable", reason: "unconfigured" })
    expect(mockPing).not.toHaveBeenCalled()
  })

  it("reports ok on a successful PONG", async () => {
    process.env.VALKEY_URL = "redis://valkey:6379"
    mockPing.mockResolvedValue("PONG")

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "ok" })
  })

  it("reports unavailable when the ping rejects", async () => {
    process.env.VALKEY_URL = "redis://valkey:6379"
    mockPing.mockRejectedValue(new Error("connection closed"))

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "unavailable", reason: "timeout_or_network" })
  })
})

describe("getDependencyHealthSnapshot: coalescing + success-only caching", () => {
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
    mockLiveStreamStatus.mockReturnValue({ dependency: "valkey", state: "ok", observedAt: new Date().toISOString() })
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it("coalesces 10 concurrent calls into exactly one probe run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    const results = await Promise.all(Array.from({ length: 10 }, () => getDependencyHealthSnapshot()))

    // 4 HTTP dependencies (prometheus/argocd/gitea/keycloak) + 1 kubernetes probe fetch = 5
    // fetch calls total if (and only if) the 10 concurrent callers shared one run.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
    expect(mockPing).toHaveBeenCalledTimes(1)
    // every caller gets the same snapshot content
    for (const r of results) expect(r).toEqual(results[0])
  })

  it("caches a fully-ok snapshot and serves the next call from cache without re-probing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    await getDependencyHealthSnapshot()
    expect(mockCacheSet).toHaveBeenCalledTimes(1)

    await getDependencyHealthSnapshot()

    // second call hit the cache — no additional fetch/ping calls beyond the first run's.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
    expect(mockPing).toHaveBeenCalledTimes(1)
  })

  it("does not cache a snapshot where any dependency is unavailable, and re-probes on the next call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.includes("argocd") ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve({ ok: true, status: 200 } as Response)
      )
    )

    const first = await getDependencyHealthSnapshot()
    const argocdFirst = first.dependencies.find((d) => d.dependency === "argocd")
    expect(argocdFirst?.state).toBe("unavailable")
    expect(mockCacheSet).not.toHaveBeenCalled()

    await getDependencyHealthSnapshot()

    // second call re-probed instead of serving a cached (nonexistent) entry — 5 + 5 fetch calls.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(10)
  })

  it("does not cache a snapshot where any dependency is unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.includes("keycloak")
          ? Promise.resolve({ ok: false, status: 401 } as Response)
          : Promise.resolve({ ok: true, status: 200 } as Response)
      )
    )

    await getDependencyHealthSnapshot()

    expect(mockCacheSet).not.toHaveBeenCalled()
  })

  it("ignores an expired local live-stream degradation when the Valkey probe succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
    mockLiveStreamStatus.mockReturnValue({
      dependency: "valkey",
      state: "partial",
      observedAt: new Date(Date.now() - 31_000).toISOString(),
      reason: "persistence_failure",
    })

    const snapshot = await getDependencyHealthSnapshot()

    expect(snapshot.dependencies.find((item) => item.dependency === "valkey")?.state).toBe("ok")
    expect(mockCacheSet).toHaveBeenCalledTimes(1)
  })
})

describe("getDependencyHealthSummary: bounded aggregate caching", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, PROMETHEUS_URL: "https://prometheus.narwhal.internal", ARGOCD_URL: "https://argocd.narwhal.internal", GITEA_URL: "https://gitea.narwhal.internal", KEYCLOAK_ISSUER: "https://keycloak.narwhal.internal", VALKEY_URL: "redis://valkey:6379" }
    fakeCacheStore.clear()
    mockCacheGet.mockClear()
    mockCacheSet.mockClear()
    mockPing.mockReset()
    mockPing.mockResolvedValue("PONG")
    mockLiveStreamStatus.mockReturnValue({ dependency: "valkey", state: "ok", observedAt: new Date().toISOString() })
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it("caches degraded summary across 10 sequential calls and stores only aggregate fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) =>
      url.includes("argocd") ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve({ ok: true, status: 200 } as Response)
    ))

    const results = []
    for (let index = 0; index < 10; index += 1) results.push(await getDependencyHealthSummary())

    expect(results.every((result) => result.state === "degraded")).toBe(true)
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
    const summaryEntry = fakeCacheStore.get("health:summary")
    expect(summaryEntry).toEqual({ state: "degraded", observedAt: expect.any(String) })
    expect(Object.keys(summaryEntry as object).sort()).toEqual(["observedAt", "state"])
    expect(mockCacheSet).toHaveBeenCalledWith("health:summary", summaryEntry, 20)
  })

  it("coalesces concurrent summary cache misses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return url.includes("argocd") ? Promise.reject(new Error("ECONNREFUSED")) : { ok: true, status: 200 } as Response
    }))

    await Promise.all(Array.from({ length: 10 }, () => getDependencyHealthSummary()))

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5)
  })
})
