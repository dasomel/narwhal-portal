import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Unlike route.test.ts (which mocks getDependencyHealthSnapshot), this runs the real lib against
// an in-memory cache so a tampered Valkey entry reaches the route's response path (portal#47).
const fakeCacheStore = new Map<string, unknown>()

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue({ session: { user: { role: "cluster-admin" } } }),
}))
vi.mock("@/lib/config", () => ({ getK8sApiServer: () => "http://k8s.test" }))
vi.mock("@/lib/k8s-token", () => ({ getK8sBearerToken: () => "", invalidateK8sBearerToken: vi.fn() }))
vi.mock("@/lib/valkey", () => ({
  getValkey: () => ({ ping: async () => "PONG" }),
  cacheGet: async (key: string) => (fakeCacheStore.has(key) ? fakeCacheStore.get(key) : null),
  cacheSet: async (key: string, value: unknown) => void fakeCacheStore.set(key, value),
}))
vi.mock("@/lib/live-stream", () => ({
  getLiveStreamStatus: () => ({ dependency: "valkey", state: "ok", observedAt: new Date().toISOString() }),
  getLiveStreamMetrics: () => ({}),
}))
vi.mock("@/lib/live-k8s-informer", () => ({ getLiveK8sInformerStatus: () => ({}) }))

import { GET } from "./route"

const at = "2026-10-15T00:00:00.000Z"
const okEntries = ["prometheus", "kubernetes", "argocd", "gitea", "keycloak", "valkey"].map((dependency) => ({
  dependency,
  state: "ok",
  observedAt: at,
}))

describe("GET /api/health/dependencies with a cached snapshot (portal#47)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, PROMETHEUS_URL: "http://prom.test", ARGOCD_URL: "http://argo.test" }
    fakeCacheStore.clear()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it("serves a well-formed cached snapshot as-is", async () => {
    fakeCacheStore.set("health:dependencies", { observedAt: at, dependencies: okEntries })

    const json = await (await GET()).json()

    expect(json.dependencies).toEqual(okEntries)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ["empty list", { observedAt: at, dependencies: [] }],
    ["non-array dependencies", { observedAt: at, dependencies: { ok: true } }],
    ["tampered status", { observedAt: at, dependencies: okEntries.map((d) => ({ ...d, state: "healthy" })) }],
    ["missing field", { observedAt: at, dependencies: okEntries.map(({ state, ...rest }) => (void state, rest)) }],
  ])("never returns a tampered cached snapshot (%s) — re-probes and reports real failures", async (_name, tampered) => {
    fakeCacheStore.set("health:dependencies", tampered)

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalled()
    expect(json.dependencies).toHaveLength(6)
    expect(json.dependencies.find((d: { dependency: string }) => d.dependency === "prometheus").state).toBe("unavailable")
    expect(json.dependencies.find((d: { dependency: string }) => d.dependency === "gitea").reason).toBe("unconfigured")
  })
})
