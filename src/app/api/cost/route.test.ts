import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import type { NamespaceInfo } from "@/lib/k8s-client"
import type { EffectiveScope } from "@/lib/scope"

// portal#28: GET /api/cost authorized via requireRole but never scoped the returned
// namespace/service items (or the single "cluster" aggregate) to the caller's team —
// any developer/viewer saw every team's cost data. @/lib/scope is left real (like
// catalog/scorecards route tests) so this exercises the actual getVisibilityScope +
// namespaceVisible resolution against config/role-filter.json, not a stand-in for it.
// @/lib/valkey is a no-op mock so getCost's cache is exercised without a real Valkey.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces } = await import("@/lib/k8s-client")
const { getEffectiveScope } = await import("@/lib/scope")
const { getCost, getCostByService, getCostTrend } = await import("@/lib/cost")
const { GET } = await import("./route")

const pricingEnvNames = [
  "NODE_ENV",
  "COST_CPU_HOURLY",
  "COST_MEM_GB_HOURLY",
  "COST_STORAGE_GB_HOURLY",
  "COST_CURRENCY",
  "COST_PRICING_VERSION",
  "COST_PRICING_EFFECTIVE_DATE",
  "COST_PRICING_SOURCE",
  "COST_PRICING_SCOPE",
] as const
const originalPricingEnv = Object.fromEntries(
  pricingEnvNames.map((name) => [name, process.env[name]])
)

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }
const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

// platform-system: 2 cores / 4GB mem -> totalHourly 0.1
// frontend-app:    1 core  / 2GB mem -> totalHourly 0.05
// (default unit prices: cpuHourly=0.04, memGbHourly=0.005; storage rows omitted -> 0)
function fakeFetch(url: string) {
  // getCostTrend uses query_range, not query — its result shape is {metric,values}
  // (a series of points), not {metric,value} (a single instant sample). Route on
  // "query_range" first or a trend call falls into the instant-vector branches below
  // and gets a shape rangeStatus treats as empty (portal#64 Codex 리뷰 #1).
  if (url.includes("query_range")) {
    return jsonResponse([{ metric: {}, values: [[1700000000, "2.0"], [1700086400, "2.5"]] }])
  }
  if (url.includes("container_cpu_usage_seconds_total")) {
    return jsonResponse([
      { metric: { namespace: "platform-system" }, value: [0, "2"] },
      { metric: { namespace: "frontend-app" }, value: [0, "1"] },
    ])
  }
  if (url.includes("container_memory_working_set_bytes")) {
    return jsonResponse([
      { metric: { namespace: "platform-system" }, value: [0, "4000000000"] },
      { metric: { namespace: "frontend-app" }, value: [0, "2000000000"] },
    ])
  }
  if (url.includes("kubelet_volume_stats_used_bytes")) {
    return jsonResponse([
      // Regression fixture: a namespace with PVC usage but no CPU/memory
      // sample must still appear in namespace cost results.
      { metric: { namespace: "storage-only" }, value: [0, "1000000000"] },
    ])
  }
  return jsonResponse([])
}
function jsonResponse(result: unknown) {
  return { ok: true, json: async () => ({ data: { result } }) } as Response
}

function requestUrl(scope?: string) {
  return new NextRequest(`http://localhost/api/cost${scope ? `?scope=${scope}` : ""}`)
}

function configurePricing(version = "2026.06") {
  process.env.COST_CPU_HOURLY = "6.82"
  process.env.COST_MEM_GB_HOURLY = "1.22"
  process.env.COST_STORAGE_GB_HOURLY = "0.0037"
  process.env.COST_CURRENCY = "KRW"
  process.env.COST_PRICING_VERSION = version
  process.env.COST_PRICING_EFFECTIVE_DATE = "2026-06-12"
  process.env.COST_PRICING_SOURCE = "on-prem TCO"
  process.env.COST_PRICING_SCOPE = "narwhal-prod"
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(fakeFetch(url))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const name of pricingEnvNames) {
    const value = originalPricingEnv[name]
    if (value === undefined) delete process.env[name]
    else (process.env as Record<string, string | undefined>)[name] = value
  }
})

describe("GET /api/cost — scope enforcement", () => {
  it("includes namespaces represented only by storage metrics", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    const res = await GET(requestUrl("namespace"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const storageOnly = body.items.find((item: { id: string }) => item.id === "storage-only")
    expect(storageOnly).toMatchObject({
      id: "storage-only",
      cpu: { cores: 0 },
      memory: { gb: 0 },
      storage: { gb: 1 },
    })
  })

  it("exposes the service-scope storage exclusion", async () => {
    const scope = await getEffectiveScope(adminSession)
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("container_cpu_usage_seconds_total")) {
        return Promise.resolve(jsonResponse([{
          metric: { namespace: "frontend-app", label_app_kubernetes_io_instance: "portal" },
          value: [0, "1"],
        }]))
      }
      return Promise.resolve(jsonResponse([{
        metric: { namespace: "frontend-app", label_app_kubernetes_io_instance: "portal" },
        value: [0, "1000000000"],
      }]))
    }))

    const result = await getCost("service", scope)
    expect(result.notice).toContain("PVC/storage")
  })

  it("does not leak another team's namespace cost to a cross-scope caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(requestUrl("namespace"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.items.map((i: { id: string }) => i.id)
    expect(ids).toEqual(["frontend-app"])
  })

  it("returns the caller's own team namespace cost (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(requestUrl("namespace"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.items.map((i: { id: string }) => i.id)
    expect(ids).toEqual(["platform-system"])
  })

  it("cluster-admin sees every namespace's cost", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    const res = await GET(requestUrl("namespace"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.items.map((i: { id: string }) => i.id).sort()
    expect(ids).toEqual(["frontend-app", "platform-system", "storage-only"])
  })

  it("scopes the aggregated cluster total too, not just the namespace/service list", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const scoped = await GET(requestUrl()) // default scope=cluster
    const scopedBody = await scoped.json()
    expect(scopedBody.items).toEqual([expect.objectContaining({ id: "cluster", totalHourly: 0.1 })])

    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    const full = await GET(requestUrl())
    const fullBody = await full.json()
    expect(fullBody.items).toEqual([expect.objectContaining({ id: "cluster", totalHourly: 0.1501 })])
  })

  it("keys the cache by scope fingerprint, not one shared literal key", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    await GET(requestUrl("namespace"))
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    await GET(requestUrl("namespace"))
    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0])
    expect(new Set(setKeys).size).toBe(2)
  })

  it("keeps detail metrics for a service already authorized through its ArgoCD project", async () => {
    const projectOnlyScope: EffectiveScope = {
      all: false,
      namespaces: new Set(),
      argocdProjects: ["apps"],
      hasMapping: true,
      fingerprint: "project-only",
      resolved: { all: false, names: new Set(), byLabel: new Set(), byPattern: new Set() },
      clusterId: "default",
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse([
      {
        metric: {
          namespace: "frontend-app",
          label_app_kubernetes_io_instance: "portal",
          ...(url.includes("container_cpu_usage_seconds_total") ? { pod: "portal-0" } : {}),
        },
        value: [0, url.includes("container_cpu_usage_seconds_total") ? "2" : "4000000000"],
      },
    ])))

    const result = await getCostByService("portal", projectOnlyScope, "frontend-app")

    expect(result).toMatchObject({ serviceId: "portal", totalHourly: 0.1 })
  })

  it("changes scoped detail cache keys when resolved namespace visibility is revoked", async () => {
    vi.mocked(getNamespaces)
      .mockResolvedValueOnce([namespaces[0]])
      .mockResolvedValueOnce([namespaces[1]])
    const beforeRevocation = await getEffectiveScope(platformTeamSession)
    const afterRevocation = await getEffectiveScope(platformTeamSession)

    await getCostByService("portal", beforeRevocation, "platform-system")
    await getCostByService("portal", afterRevocation, "platform-system")

    const detailKeys = vi.mocked(cacheSet).mock.calls
      .map(([key]) => key)
      .filter((key) => key.startsWith("cost:service:v2:"))
    expect(new Set(detailKeys).size).toBe(2)
  })

  it("returns estimate and configured pricing provenance to the dashboard", async () => {
    configurePricing()
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)

    const res = await GET(requestUrl())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pricing).toEqual({
      estimate: true,
      currency: "KRW",
      version: "2026.06",
      effectiveDate: "2026-06-12",
      source: "on-prem TCO",
      scope: "narwhal-prod",
      configured: true,
    })
    expect(body.unitPrices).toEqual({ cpuHourly: 6.82, memGbHourly: 1.22, storageGbHourly: 0.0037 })
  })

  it("rejects missing production pricing instead of using development placeholders", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    for (const name of pricingEnvNames.filter((name) => name !== "NODE_ENV")) delete process.env[name]
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)

    const res = await GET(requestUrl())
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      error: "Cost pricing is not configured",
      invalid: expect.arrayContaining(["COST_CPU_HOURLY", "COST_CURRENCY", "COST_PRICING_VERSION"]),
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects an invalid production unit price instead of falling back", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.COST_CPU_HOURLY = "not-a-number"
    process.env.COST_MEM_GB_HOURLY = "1.22"
    process.env.COST_STORAGE_GB_HOURLY = "0.0037"
    process.env.COST_CURRENCY = "KRW"
    process.env.COST_PRICING_VERSION = "2026.06"
    process.env.COST_PRICING_EFFECTIVE_DATE = "2026-06-12"
    process.env.COST_PRICING_SOURCE = "on-prem TCO"
    process.env.COST_PRICING_SCOPE = "narwhal-prod"
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)

    const res = await GET(requestUrl())
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      invalid: ["COST_CPU_HOURLY"],
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("separates list, detail, and trend caches when pricing changes", async () => {
    configurePricing("2026.06")
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    const scope = await getEffectiveScope(adminSession)
    await GET(requestUrl())
    await getCostByService("portal", scope, "platform-system")
    await getCostTrend("cluster", "cluster", 7, scope)

    configurePricing("2026.07")
    await GET(requestUrl())
    await getCostByService("portal", scope, "platform-system")
    await getCostTrend("cluster", "cluster", 7, scope)

    const setKeys = vi.mocked(cacheSet).mock.calls.map(([key]) => key)
    for (const prefix of ["cost:v2:cluster:", "cost:service:v2:", "cost:trend:v2:cluster:"]) {
      const matching = setKeys.filter((key) => key.startsWith(prefix))
      expect(new Set(matching).size).toBe(2)
    }
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(requestUrl())
    expect(res.status).toBe(401)
  })

  // portal#64 AC4: a Prometheus outage must be distinguishable from a genuinely
  // empty result — both previously surfaced as `{ items: [], notice }`.
  it("exposes telemetry.state=unavailable (not just an empty items array) when Prometheus is down", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))

    const res = await GET(requestUrl("cluster"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(body.telemetry.state).toBe("unavailable")
  })

  // portal#64 AC3: service scope must expose exclusions as structured fields, not
  // only the free-text Korean `notice` prose.
  it("exposes structured exclusions for service scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)

    const res = await GET(requestUrl("service"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.exclusions.storageExcludedFromServiceScope).toBe(true)
    expect(body.exclusions.unlabeledWorkloads).toBeDefined()
    expect(body.telemetry.state).toBe("ok")
  })
})
