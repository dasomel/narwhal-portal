import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { NamespaceInfo } from "./k8s-client"

const cacheStore = new Map<string, unknown>()

vi.mock("./valkey", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value)
  }),
}))

vi.mock("./k8s-client", () => ({
  getNamespaces: vi.fn(),
}))

const { cacheGet, cacheSet } = await import("./valkey")
const { getNamespaces } = await import("./k8s-client")
const { getEffectiveScope } = await import("./scope")
const { scopeFingerprint } = await import("./role-filter")
const { getCost, getCostByService, getCostTrend } = await import("./cost")

const testNamespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function jsonResponse(result: unknown) {
  return { ok: true, json: async () => ({ data: { result } }) } as Response
}

describe("cost cache multi-cluster and cross-scope isolation (Portal #64)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    cacheStore.clear()
    vi.clearAllMocks()
    vi.mocked(getNamespaces).mockResolvedValue(testNamespaces)

    // Standard fake Prometheus response
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("query_range")) {
        return jsonResponse([
          {
            metric: {},
            values: [
              [1700000000, "2.0"],
              [1700086400, "2.5"],
            ],
          },
        ])
      }
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([
          {
            metric: {
              namespace: "platform-system",
              label_app_kubernetes_io_instance: "platform-svc",
              pod: "platform-pod-0",
            },
            value: [0, "1.5"],
          },
        ])
      }
      if (url.includes("container_memory_working_set_bytes")) {
        return jsonResponse([
          {
            metric: {
              namespace: "platform-system",
              label_app_kubernetes_io_instance: "platform-svc",
              pod: "platform-pod-0",
            },
            value: [0, "2000000000"],
          },
        ])
      }
      if (url.includes("kubelet_volume_stats_used_bytes")) {
        return jsonResponse([
          {
            metric: { namespace: "platform-system" },
            value: [0, "1000000000"],
          },
        ])
      }
      return jsonResponse([])
    }))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("scopeFingerprint isolates digests when only clusterId differs", () => {
    const groups = ["developer"]
    const teams = ["platform-team"]
    const namespaces = ["platform-system"]

    const fpClusterA = scopeFingerprint(groups, teams, "cluster-alpha", namespaces)
    const fpClusterB = scopeFingerprint(groups, teams, "cluster-beta", namespaces)

    expect(fpClusterA).not.toBe(fpClusterB)
    expect(fpClusterA).toHaveLength(32)
    expect(fpClusterB).toHaveLength(32)

    // Also holds for unmapped scopes with no namespaces
    const emptyA = scopeFingerprint(groups, teams, "cluster-alpha")
    const emptyB = scopeFingerprint(groups, teams, "cluster-beta")
    expect(emptyA).not.toBe(emptyB)
  })

  it("produces distinct cost cache keys for namespace queries across different clusters", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    expect(scopeClusterA.clusterId).toBe("cluster-alpha")
    expect(scopeClusterB.clusterId).toBe("cluster-beta")
    expect(scopeClusterA.fingerprint).not.toBe(scopeClusterB.fingerprint)

    await getCost("namespace", scopeClusterA)
    await getCost("namespace", scopeClusterB)

    const setCalls = vi.mocked(cacheSet).mock.calls
    const namespaceKeys = setCalls
      .map(([key]) => key)
      .filter((k) => k.startsWith("cost:namespace:"))

    expect(namespaceKeys).toHaveLength(2)
    expect(namespaceKeys[0]).not.toBe(namespaceKeys[1])
    expect(namespaceKeys[0]).toContain(scopeClusterA.fingerprint)
    expect(namespaceKeys[1]).toContain(scopeClusterB.fingerprint)
  })

  it("produces distinct cost cache keys for service queries across different clusters", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    await getCostByService("platform-svc", scopeClusterA, "platform-system")
    await getCostByService("platform-svc", scopeClusterB, "platform-system")

    const setCalls = vi.mocked(cacheSet).mock.calls
    const serviceKeys = setCalls
      .map(([key]) => key)
      .filter((k) => k.startsWith("cost:service:"))

    expect(serviceKeys).toHaveLength(2)
    expect(serviceKeys[0]).not.toBe(serviceKeys[1])
    expect(serviceKeys[0]).toContain(scopeClusterA.fingerprint)
    expect(serviceKeys[1]).toContain(scopeClusterB.fingerprint)
  })

  it("produces distinct cost cache keys for trend queries across different clusters", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    await getCostTrend("namespace", "platform-system", 7, scopeClusterA)
    await getCostTrend("namespace", "platform-system", 7, scopeClusterB)

    const setCalls = vi.mocked(cacheSet).mock.calls
    const trendKeys = setCalls
      .map(([key]) => key)
      .filter((k) => k.startsWith("cost:trend:namespace:"))

    expect(trendKeys).toHaveLength(2)
    expect(trendKeys[0]).not.toBe(trendKeys[1])
    expect(trendKeys[0]).toContain(scopeClusterA.fingerprint)
    expect(trendKeys[1]).toContain(scopeClusterB.fingerprint)
  })

  it("ensures a namespace cost value cached for cluster A is never returned for cluster B", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    // 1. Cluster A queries and populates Valkey cache with Cluster A specific values
    const clusterAResult = await getCost("namespace", scopeClusterA)
    expect(clusterAResult.items.length).toBeGreaterThan(0)
    expect(cacheStore.size).toBe(1)

    // 2. Mock fetch to return different metrics for Cluster B
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([
          {
            metric: { namespace: "platform-system" },
            value: [0, "10.0"], // Distinct from cluster A's 1.5
          },
        ])
      }
      return jsonResponse([])
    }))

    // 3. Cluster B queries cost for the same namespace under its own scope
    const clusterBResult = await getCost("namespace", scopeClusterB)

    // Cluster B must get fresh Prometheus results computed for Cluster B, NOT Cluster A's cached items
    expect(clusterBResult.items).not.toEqual(clusterAResult.items)
    const clusterBCpu = clusterBResult.items.find((i) => i.id === "platform-system")?.cpu.cores
    const clusterACpu = clusterAResult.items.find((i) => i.id === "platform-system")?.cpu.cores
    expect(clusterBCpu).toBe(10)
    expect(clusterACpu).toBe(1.5)

    // Cache now holds two separate entries
    expect(cacheStore.size).toBe(2)

    // 4. Repeated query for Cluster A still returns Cluster A's cached value without calling fetch
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockClear()
    const cachedClusterA = await getCost("namespace", scopeClusterA)
    expect(cachedClusterA).toEqual(clusterAResult)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("ensures a service detail cost value cached for cluster A is never returned for cluster B", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    // 1. Cluster A populates cache
    const resultA = await getCostByService("platform-svc", scopeClusterA, "platform-system")
    expect("serviceId" in resultA).toBe(true)

    // 2. Change Prometheus metrics for Cluster B
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([
          {
            metric: {
              namespace: "platform-system",
              label_app_kubernetes_io_instance: "platform-svc",
              pod: "cluster-b-pod",
            },
            value: [0, "8.0"],
          },
        ])
      }
      return jsonResponse([])
    }))

    // 3. Cluster B queries cost for the same service
    const resultB = await getCostByService("platform-svc", scopeClusterB, "platform-system")
    expect("serviceId" in resultB).toBe(true)
    if ("serviceId" in resultA && "serviceId" in resultB) {
      expect(resultB.cpu.cores).toBe(8)
      expect(resultA.cpu.cores).toBe(1.5)
      expect(resultB.totalHourly).not.toBe(resultA.totalHourly)
    }

    // 4. Repeated query for Cluster A hits cache
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockClear()
    const cachedA = await getCostByService("platform-svc", scopeClusterA, "platform-system")
    expect(cachedA).toEqual(resultA)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("ensures a cost trend value cached for cluster A is never returned for cluster B", async () => {
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scopeClusterA = await getEffectiveScope(session, "cluster-alpha")
    const scopeClusterB = await getEffectiveScope(session, "cluster-beta")

    // 1. Cluster A queries trend and caches result
    const trendA = await getCostTrend("namespace", "platform-system", 7, scopeClusterA)
    expect(trendA.points.length).toBeGreaterThan(0)

    // 2. Mock fetch to return different trend data for Cluster B
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      {
        metric: {},
        values: [
          [1700000000, "99.0"],
        ],
      },
    ])))

    // 3. Cluster B queries trend
    const trendB = await getCostTrend("namespace", "platform-system", 7, scopeClusterB)
    expect(trendB.points).not.toEqual(trendA.points)
    expect(trendB.points[0].total).toBeGreaterThan(trendA.points[0].total)

    // 4. Cluster A returns cached trend without calling fetch
    const fetchSpy = vi.mocked(global.fetch)
    fetchSpy.mockClear()
    const cachedTrendA = await getCostTrend("namespace", "platform-system", 7, scopeClusterA)
    expect(cachedTrendA).toEqual(trendA)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
