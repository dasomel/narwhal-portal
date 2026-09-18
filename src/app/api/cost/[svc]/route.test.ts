import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#61: GET /api/cost/[svc] had no resource-scope check at all — any
// authenticated developer/viewer could pull cost + top-pod detail for any service id
// regardless of team ownership. Gated the same way scorecards/[svc] and
// catalog/[name] are: resolve the ArgoCD app for the id, require appVisible.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApp: vi.fn() }
})
vi.mock("@/lib/cost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cost")>()
  return { ...actual, getCostByService: vi.fn() }
})
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { getArgoApp } = await import("@/lib/argocd")
const { getCostByService } = await import("@/lib/cost")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

const platformApp: ArgoApp = {
  metadata: { name: "platform-app" },
  spec: { project: "platform", destination: { namespace: "platform-system" } },
  status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
}

function params(svc: string) {
  return { params: Promise.resolve({ svc }) }
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApp).mockImplementation(async (name: string) => (name === "platform-app" ? platformApp : null))
  vi.mocked(getCostByService).mockResolvedValue({
    id: "platform-app",
    serviceId: "platform-app",
    cpu: { cores: 1, hourly: 0.04 },
    memory: { gb: 1, hourly: 0.005 },
    storage: { gb: 0, hourly: 0 },
    totalHourly: 0.045,
    totalMonthly: 32.4,
    topPods: [],
  })
})

describe("GET /api/cost/[svc] — scope enforcement", () => {
  it("404s a guessed service id outside the caller's scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/platform-app"), params("platform-app"))
    expect(res.status).toBe(404)
    expect(getCostByService).not.toHaveBeenCalled()
  })

  it("404s an id that does not resolve to any ArgoCD app", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/unknown-app"), params("unknown-app"))
    expect(res.status).toBe(404)
  })

  it("returns detail for a service the caller's team owns (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/platform-app"), params("platform-app"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.serviceId).toBe("platform-app")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(new NextRequest("http://localhost/api/cost/platform-app"), params("platform-app"))
    expect(res.status).toBe(401)
  })
})
