import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#61: GET /api/cost/trend accepted scope=namespace|service&id=<anything> with
// no ownership check — a caller with a valid role could read another team's
// namespace/service cost trend by guessing an id. namespace scope now checks
// namespaceVisible(id) directly; service scope resolves id via ArgoCD like
// cost/[svc] and scorecards/[svc] do, and also validates + pins the resolved
// destination namespace so the PromQL query itself is scoped to it. @/lib/cost is
// left real (not mocked) so both the route-level checks and the namespace-pinning
// defense inside getCostTrend are actually exercised end to end against a stubbed
// fetch/valkey.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/argocd", () => ({ getArgoApp: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { getArgoApp } = await import("@/lib/argocd")
const { getNamespaces } = await import("@/lib/k8s-client")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }
const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

const platformApp: ArgoApp = {
  metadata: { name: "platform-app" },
  spec: { project: "platform", destination: { namespace: "platform-system" } },
  status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
}

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

function configurePricing() {
  process.env.COST_CPU_HOURLY = "6.82"
  process.env.COST_MEM_GB_HOURLY = "1.22"
  process.env.COST_STORAGE_GB_HOURLY = "0.0037"
  process.env.COST_CURRENCY = "KRW"
  process.env.COST_PRICING_VERSION = "2026.06"
  process.env.COST_PRICING_EFFECTIVE_DATE = "2026-06-12"
  process.env.COST_PRICING_SOURCE = "on-prem TCO"
  process.env.COST_PRICING_SCOPE = "narwhal-prod"
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApp).mockImplementation(async (name: string) => (name === "platform-app" ? platformApp : null))
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: { result: [{ metric: {}, values: [[1, "2"]] }] } }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const name of pricingEnvNames) {
    const value = originalPricingEnv[name]
    if (value === undefined) delete process.env[name]
    else (process.env as Record<string, string | undefined>)[name] = value
  }
})

describe("GET /api/cost/trend — scope enforcement", () => {
  it("403s scope=namespace with an id outside the caller's scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=namespace&id=platform-system"))
    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("allows scope=namespace with an id inside the caller's scope (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=namespace&id=platform-system"))
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalled()
  })

  it("404s scope=service with a guessed id outside the caller's scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=service&id=platform-app"))
    expect(res.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("404s scope=service with an id that resolves to no ArgoCD app", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=service&id=unknown-app"))
    expect(res.status).toBe(404)
  })

  it("allows scope=service with an id the caller's team owns (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=service&id=platform-app"))
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalled()
  })

  it("allows scope=cluster for any authenticated caller (aggregate, filtered inside getCostTrend)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=cluster"))
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalled()
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=cluster"))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cost/trend pricing", () => {
  it("returns configured estimate pricing provenance", async () => {
    configurePricing()

    const res = await GET(new NextRequest("http://localhost/api/cost/trend?days=7"))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      pricing: {
        estimate: true,
        currency: "KRW",
        version: "2026.06",
        effectiveDate: "2026-06-12",
        source: "on-prem TCO",
        scope: "narwhal-prod",
        configured: true,
      },
    }))
  })

  it("returns 503 for missing production pricing without querying Prometheus", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    for (const name of pricingEnvNames.filter((name) => name !== "NODE_ENV")) delete process.env[name]

    const res = await GET(new NextRequest("http://localhost/api/cost/trend?days=7"))

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      error: "Cost pricing is not configured",
      invalid: expect.arrayContaining(["COST_CPU_HOURLY", "COST_PRICING_VERSION"]),
    }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects an invalid authorized app destination namespace before PromQL is queried", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue({
      metadata: { namespace: 'frontend-app"} or vector(1) or namespace="frontend-app' },
      spec: {
        destination: { namespace: 'frontend-app"} or vector(1) or namespace="frontend-app' },
        project: "apps",
      },
    } as never)

    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=service&id=platform-app&days=7"))

    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the Kubernetes default namespace when an app omits its destination namespace", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue({
      metadata: { namespace: "argocd" },
      spec: { destination: {}, project: "default" },
    } as never)

    const res = await GET(new NextRequest("http://localhost/api/cost/trend?scope=service&id=platform-app&days=7"))

    expect(res.status).toBe(200)
    expect(decodeURIComponent(vi.mocked(fetch).mock.calls[0][0] as string)).toContain('namespace="default"')
  })

  it("uses effective-scope cache keys and namespace-limited cluster queries", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)

    await GET(new NextRequest("http://localhost/api/cost/trend?scope=cluster&days=7"))

    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    await GET(new NextRequest("http://localhost/api/cost/trend?scope=cluster&days=7"))

    const keys = vi.mocked(cacheSet).mock.calls.map(([key]) => key)
    expect(keys.every((key) => key.includes("cost:trend:cluster:"))).toBe(true)
    expect(new Set(keys).size).toBe(2)
    const query = decodeURIComponent(vi.mocked(fetch).mock.calls[0][0] as string)
    expect(query).toContain('namespace=~"^(?:frontend-app)$"')
  })
})
