import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#61: GET /api/cost/[svc] had no resource-scope check at all — any
// authenticated developer/viewer could pull cost + top-pod detail for any service id
// regardless of team ownership. Gated the same way scorecards/[svc] and
// catalog/[name] are: resolve the ArgoCD app for the id, require appVisible, and also
// validate + pin the resolved destination namespace so the PromQL query itself can't
// be steered by a malformed namespace value (getCostByService is exercised for real
// here, not mocked, so the namespace-pinning defense actually runs).
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/argocd", () => ({ getArgoApp: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { getArgoApp } = await import("@/lib/argocd")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }
const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function app(namespace: string) {
  return { metadata: { namespace }, spec: { destination: { namespace }, project: "default" } }
}

function params(svc: string) {
  return { params: Promise.resolve({ svc }) }
}

function request(svc = "platform-app") {
  return new NextRequest(`http://localhost/api/cost/${svc}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ data: { result: url.includes("container_cpu_usage_seconds_total")
      ? [{ metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "platform-app", pod: "platform-pod" }, value: [0, "2"] }]
      : [{ metric: { namespace: "platform-system", label_app_kubernetes_io_instance: "platform-app", pod: "platform-pod" }, value: [0, "4000000000"] }],
    } }),
  })))
})

afterEach(() => vi.unstubAllGlobals())

describe("GET /api/cost/[svc] — scope enforcement", () => {
  it("404s a guessed service id outside the caller's scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue(app("platform-system") as never)

    const res = await GET(request("platform-app"), params("platform-app"))

    expect(res.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("404s an id that does not resolve to any ArgoCD app", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue(null)

    const res = await GET(request("unknown-app"), params("unknown-app"))

    expect(res.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns detail for a service the caller's team owns (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue(app("platform-system") as never)

    const res = await GET(request("platform-app"), params("platform-app"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.serviceId).toBe("platform-app")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(request("platform-app"), params("platform-app"))
    expect(res.status).toBe(401)
  })

  it("uses the effective scope fingerprint in detail cache keys", async () => {
    vi.mocked(getArgoApp).mockResolvedValue(app("platform-system") as never)
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    await GET(request(), params("platform-app"))

    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue(app("frontend-app") as never)
    await GET(request(), params("platform-app"))

    const keys = vi.mocked(cacheSet).mock.calls.map(([key]) => key).filter((key) => key.startsWith("cost:service:v2:"))
    expect(new Set(keys).size).toBe(2)
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

    const res = await GET(request(), params("platform-app"))

    expect(res.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses the Kubernetes default namespace when an app omits its destination namespace", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue({
      metadata: { namespace: "argocd" },
      spec: { destination: {}, project: "default" },
    } as never)

    const res = await GET(request(), params("platform-app"))

    expect(res.status).toBe(200)
    expect(decodeURIComponent(vi.mocked(fetch).mock.calls[0][0] as string)).toContain('namespace="default"')
  })

  // portal#64 AC4: Prometheus outage must be exposed as telemetry.state="unavailable",
  // not just a bare `{ items: [], notice }` indistinguishable from "no cost data".
  it("exposes telemetry.state=unavailable when Prometheus is down for the service detail", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    vi.mocked(getArgoApp).mockResolvedValue(app("platform-system") as never)
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    }))

    const res = await GET(request("platform-app"), params("platform-app"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([])
    expect(body.telemetry.state).toBe("unavailable")
  })
})
