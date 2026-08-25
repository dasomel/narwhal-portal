import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#31: /api/catalog/[name] gates on appVisible/getEffectiveScope (fixed in
// b36356a — the by-name direct-reference bypass) but had no route-level test.
// See src/app/api/catalog/route.test.ts for the mocking rationale.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApp: vi.fn() }
})
vi.mock("@/lib/alertmanager", () => ({ getAlerts: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getArgoApp } = await import("@/lib/argocd")
const { getAlerts } = await import("@/lib/alertmanager")
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

function params(name: string) {
  return { params: Promise.resolve({ name }) }
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getAlerts).mockResolvedValue([])
  vi.mocked(getArgoApp).mockImplementation(async (name: string) => (name === "platform-app" ? platformApp : null))
})

describe("GET /api/catalog/[name] — scope enforcement", () => {
  it("404s a guessed app name outside the caller's scope (does not confirm existence)", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(new Request("http://localhost/api/catalog/platform-app"), params("platform-app"))
    expect(res.status).toBe(404)
  })

  it("returns detail for an app the caller's team owns (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(new Request("http://localhost/api/catalog/platform-app"), params("platform-app"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.app.metadata.name).toBe("platform-app")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(new Request("http://localhost/api/catalog/platform-app"), params("platform-app"))
    expect(res.status).toBe(401)
  })
})
