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
      .filter((k) => k.startsWith("cost:v2:namespace:"))

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
      .filter((k) => k.startsWith("cost:service:v2:"))

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
      .filter((k) => k.startsWith("cost:trend:v2:namespace:"))

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

describe("cost exclusions and telemetry (Portal #64 AC3/AC4)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    cacheStore.clear()
    vi.clearAllMocks()
    vi.mocked(getNamespaces).mockResolvedValue(testNamespaces)
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // cpuByServiceQuery/memByServiceQuery join kube_pod_labels; cpuByNamespaceQuery/
  // memByNamespaceQuery don't; unlabeledWorkloadCountQuery adds "unless on(pod" on
  // top of kube_pod_labels. Route on those distinguishing substrings so each of the
  // 5 concurrent queries in getCost("service") gets its own deterministic fixture.
  function routedFetch(overrides: Record<string, unknown[]>) {
    return vi.fn(async (url: string) => {
      // "unless on(pod, namespace)" contains a space/paren that encodeURIComponent
      // percent-encodes in the request URL — match on the plain word instead.
      if (url.includes("unless")) return jsonResponse(overrides.count ?? [])
      if (url.includes("container_cpu_usage_seconds_total") && url.includes("kube_pod_labels")) {
        return jsonResponse(overrides.labeledCpu ?? [])
      }
      if (url.includes("container_cpu_usage_seconds_total")) return jsonResponse(overrides.totalCpu ?? [])
      if (url.includes("container_memory_working_set_bytes") && url.includes("kube_pod_labels")) {
        return jsonResponse(overrides.labeledMem ?? [])
      }
      if (url.includes("container_memory_working_set_bytes")) return jsonResponse(overrides.totalMem ?? [])
      if (url.includes("kubelet_volume_stats_used_bytes")) return jsonResponse(overrides.storage ?? [])
      return jsonResponse([])
    })
  }

  it("AC3: getCost('service') computes unlabeled workload count/cost from labeled vs total totals", async () => {
    vi.stubGlobal("fetch", routedFetch({
      labeledCpu: [{ metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "1"] }],
      totalCpu: [{ metric: { namespace: "platform-system" }, value: [0, "3"] }],
      labeledMem: [{ metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "1000000000"] }],
      totalMem: [{ metric: { namespace: "platform-system" }, value: [0, "3000000000"] }],
      count: [{ metric: { namespace: "platform-system" }, value: [0, "3"] }],
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    expect(result.telemetry.state).toBe("ok")
    expect(result.exclusions?.storageExcludedFromServiceScope).toBe(true)
    expect(result.exclusions?.unlabeledWorkloads).toEqual({
      computable: true,
      count: 3,
      cpu: 2, // 3 total - 1 labeled
      memoryGb: 2, // 3GB total - 1GB labeled
      hourly: 0.09, // 2*0.04 (cpuHourly) + 2*0.005 (memGbHourly)
    })
  })

  it("AC3: getCost('service') keeps the legacy notice + telemetry ok when no labeled workloads exist (missing labels)", async () => {
    vi.stubGlobal("fetch", routedFetch({}))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    expect(result.items).toEqual([])
    expect(result.notice).toContain("label_app_kubernetes_io_instance")
    expect(result.telemetry.state).toBe("ok")
    // No labeled data and no total data either -> nothing to subtract from.
    expect(result.exclusions?.unlabeledWorkloads).toEqual({
      computable: true,
      count: 0,
      cpu: 0,
      memoryGb: 0,
      hourly: 0,
    })
  })

  it("AC3: getCost('namespace') reports total unallocated storage once in exclusions (not duplicated per item)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "2"] }])
      }
      if (url.includes("container_memory_working_set_bytes")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "4000000000"] }])
      }
      if (url.includes("kubelet_volume_stats_used_bytes")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "1000000000"] }])
      }
      return jsonResponse([])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("namespace", scope)

    const item = result.items.find((i) => i.id === "platform-system")
    expect(item?.storage.gb).toBeGreaterThan(0)
    expect((item as unknown as Record<string, unknown>).unallocatedStorage).toBeUndefined()
    expect(result.exclusions?.unallocatedStorage).toEqual({
      computable: true,
      gb: item?.storage.gb,
      hourly: item?.storage.hourly,
    })
  })

  it("AC3/AC6: getCost('namespace') marks unallocatedStorage.computable=false when the storage query fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("kubelet_volume_stats_used_bytes")) {
        throw new Error("Prometheus query failed: 500")
      }
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "2"] }])
      }
      if (url.includes("container_memory_working_set_bytes")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "4000000000"] }])
      }
      return jsonResponse([])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("namespace", scope)

    expect(result.telemetry.state).toBe("partial")
    expect(result.exclusions?.unallocatedStorage).toEqual({ computable: false, gb: null, hourly: null })
  })

  it("AC4: getCost('cluster') reports telemetry.state='unavailable' and skips caching when Prometheus is entirely down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("cluster", scope)

    expect(result.items).toEqual([])
    expect(result.telemetry.state).toBe("unavailable")
    expect(result.telemetry.source).toBe("none")
    expect(result.notice).toBeTruthy()
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("AC4: getCost('cluster') reports telemetry.state='partial' when only some Prometheus queries fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("container_memory_working_set_bytes")) {
        throw new Error("Prometheus query failed: 500")
      }
      if (url.includes("container_cpu_usage_seconds_total")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "2"] }])
      }
      if (url.includes("kubelet_volume_stats_used_bytes")) {
        return jsonResponse([{ metric: { namespace: "platform-system" }, value: [0, "1000000000"] }])
      }
      return jsonResponse([])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("cluster", scope)

    expect(result.telemetry.state).toBe("partial")
    expect(result.telemetry.reason).toBeTruthy()
    // Degraded but not discarded: the item is still computed from whatever succeeded.
    expect(result.items[0].cpu.cores).toBeGreaterThan(0)
    expect(result.items[0].memory.gb).toBe(0)
    // 크리틱 리뷰 #1: partial은 unavailable과 마찬가지로 캐시하지 않는다 — degraded
    // 값을 TTL 동안 재사용하면 Prometheus가 바로 복구돼도 계속 저평가된 값을 보여준다.
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("AC4 (크리틱 리뷰 #1): getCostByService does not cache a partial result either", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("sort_desc")) {
        // top pod queries fail; core cpu/mem-by-service queries succeed.
        throw new Error("Prometheus query failed: 500")
      }
      return jsonResponse([
        { metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "platform-svc" }, value: [0, "1"] },
      ])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCostByService("platform-svc", scope, "platform-system")

    expect(result.telemetry.state).toBe("partial")
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("AC4 (크리틱 리뷰 #1/#5): getCostTrend does not cache a partial result when only the cpu query fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("container_cpu_usage_seconds_total")) {
        throw new Error("Prometheus range query failed: 500")
      }
      return jsonResponse([{ metric: {}, values: [[1700000000, "2.0"]] }])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCostTrend("namespace", "platform-system", 7, scope)

    expect(result.telemetry.state).toBe("partial")
    // The cpu series drives which timestamps get a point; losing it collapses
    // points to empty even though mem succeeded — still must not be cached.
    expect(result.points).toEqual([])
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("크리틱 리뷰 #2: unlabeledWorkloadCountQuery excludes out-of-scope namespace counts for a non-admin caller", async () => {
    vi.stubGlobal("fetch", routedFetch({
      labeledCpu: [],
      totalCpu: [],
      labeledMem: [],
      totalMem: [],
      count: [
        { metric: { namespace: "platform-system" }, value: [0, "2"] }, // in scope
        { metric: { namespace: "frontend-app" }, value: [0, "5"] }, // out of scope for platform-team
      ],
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    // Only the visible namespace's count contributes; the other team's 5 must not leak.
    expect(result.exclusions?.unlabeledWorkloads).toEqual({
      computable: true,
      count: 2,
      cpu: 0,
      memoryGb: 0,
      hourly: 0,
    })
  })

  it("크리틱 리뷰 #3: labeled CPU accumulates (not overwrites) when a service spans multiple namespaces", async () => {
    // "monitoring" matches platform-team's role-filter mapping but only becomes
    // resolved/visible if it actually exists in the namespace list.
    vi.mocked(getNamespaces).mockResolvedValueOnce([
      ...testNamespaces,
      { name: "monitoring", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
    ])
    vi.stubGlobal("fetch", routedFetch({
      labeledCpu: [
        { metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "1"] },
        { metric: { namespace: "monitoring", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "2"] },
      ],
      totalCpu: [
        { metric: { namespace: "platform-system" }, value: [0, "1"] },
        { metric: { namespace: "monitoring" }, value: [0, "2"] },
      ],
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    // If cpuMap still overwrote instead of accumulating, this would be 2 (last write wins).
    const svcA = result.items.find((i) => i.id === "svc-a")
    expect(svcA?.cpu.cores).toBe(3)
    // Fully attributed to the (now correctly summed) service — nothing left "unlabeled".
    expect(result.exclusions?.unlabeledWorkloads).toEqual({
      computable: true,
      count: 0,
      cpu: 0,
      memoryGb: 0,
      hourly: 0,
    })
  })

  it("크리틱 리뷰 #3: unlabeled cpu/mem is clamped per namespace, not only on the grand total", async () => {
    // platform-system: total(1) < labeled(2) due to query timing skew -> would go
    // negative if summed into one grand total before clamping, silently canceling
    // out monitoring's genuine unlabeled amount. Per-namespace clamping keeps both.
    vi.mocked(getNamespaces).mockResolvedValueOnce([
      ...testNamespaces,
      { name: "monitoring", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
    ])
    vi.stubGlobal("fetch", routedFetch({
      labeledCpu: [
        { metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "2"] },
      ],
      totalCpu: [
        { metric: { namespace: "platform-system" }, value: [0, "1"] },
        { metric: { namespace: "monitoring" }, value: [0, "5"] },
      ],
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    // Grand-total-first would compute max(0, (1+5) - 2) = 4; per-namespace clamping
    // computes max(0, 1-2)=0 for platform-system + max(0, 5-0)=5 for monitoring = 5.
    expect(result.exclusions?.unlabeledWorkloads?.cpu).toBe(5)
  })

  it("크리틱 리뷰 #3: a workload labeled exactly 'unknown' is treated as unlabeled consistently", async () => {
    vi.stubGlobal("fetch", routedFetch({
      labeledCpu: [
        { metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "unknown" }, value: [0, "3"] },
      ],
      totalCpu: [{ metric: { namespace: "platform-system" }, value: [0, "3"] }],
      count: [{ metric: { namespace: "platform-system" }, value: [0, "1"] }],
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    // "unknown"-labeled workload contributes no item and no labeled cost, so its
    // full cpu shows up as unlabeled — consistent with the count query, which is
    // asked to also treat label_app_kubernetes_io_instance="unknown" as unlabeled.
    expect(result.items).toEqual([])
    expect(result.exclusions?.unlabeledWorkloads).toEqual({
      computable: true,
      count: 1,
      cpu: 3,
      memoryGb: 0,
      hourly: 0.12,
    })
  })

  it("크리틱 리뷰 #5: service scope marks unlabeledWorkloads.computable=false when an aux query fails (core still ok)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("unless")) throw new Error("Prometheus query failed: 500") // count query
      if (url.includes("container_cpu_usage_seconds_total") && url.includes("kube_pod_labels")) {
        return jsonResponse([{ metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "svc-a" }, value: [0, "1"] }])
      }
      return jsonResponse([])
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCost("service", scope)

    // Core items are unaffected by the aux query failure.
    expect(result.telemetry.state).toBe("ok")
    expect(result.items).toEqual([{
      id: "svc-a",
      cpu: { cores: 1, hourly: 0.04 },
      memory: { gb: 0, hourly: 0 },
      storage: { gb: 0, hourly: 0 },
      totalHourly: 0.04,
      totalMonthly: 29.2,
    }])
    expect(result.exclusions?.unlabeledWorkloads).toEqual({ computable: false, count: null, cpu: null, memoryGb: null, hourly: null })
  })

  it("AC4: getCostByService reports telemetry.state='unavailable' distinctly from a 200+notice-only response shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)

    const result = await getCostByService("platform-svc", scope, "platform-system")

    expect("serviceId" in result).toBe(false)
    expect(result.telemetry.state).toBe("unavailable")
    if (!("serviceId" in result)) expect(result.notice).toBeTruthy()
  })

  it("AC4: getCostTrend distinguishes a genuinely empty-but-complete result from an unavailable one", async () => {
    // A caller with no recognized role/team mapping and no matching namespaces never
    // issues a Prometheus query at all for cluster scope — genuinely empty, not a
    // telemetry failure.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])))
    const noAccessScope = await getEffectiveScope({ groups: [], teams: [] })
    expect(noAccessScope.all).toBe(false)
    expect(noAccessScope.namespaces.size).toBe(0)

    const emptyResult = await getCostTrend("cluster", "cluster", 7, noAccessScope)
    expect(emptyResult.points).toEqual([])
    expect(emptyResult.telemetry.state).toBe("empty")
    expect(fetch).not.toHaveBeenCalled()

    // Now the same shape of empty `points` but because Prometheus itself is down —
    // must be distinguishable via telemetry.state, not conflated with the above.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))
    const session = { groups: ["developer"], teams: ["platform-team"] }
    const scope = await getEffectiveScope(session)
    const downResult = await getCostTrend("namespace", "platform-system", 7, scope)

    expect(downResult.points).toEqual([])
    expect(downResult.telemetry.state).toBe("unavailable")
    expect(downResult.telemetry.state).not.toBe(emptyResult.telemetry.state)
  })
})
