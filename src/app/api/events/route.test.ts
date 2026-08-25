import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#14: /api/events applies appVisible/alertVisible/getEffectiveScope and keys
// its cache by scope.fingerprint (the cross-tenant cache-poisoning bug documented in
// docs/lessons-log.md 2026-08-20). The underlying predicates are each unit-tested
// (role-filter.test.ts, event-visibility.test.ts) but the route itself had no
// end-to-end test. Mocking rationale: see src/app/api/catalog/route.test.ts.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})
vi.mock("@/lib/alertmanager", () => ({ getAlerts: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getArgoApps } = await import("@/lib/argocd")
const { getAlerts } = await import("@/lib/alertmanager")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function fakeApp(name: string, project: string, namespace: string): ArgoApp {
  return {
    metadata: { name },
    spec: { project, destination: { namespace } },
    status: {
      sync: { status: "Synced" },
      health: { status: "Healthy" },
      history: [{ id: 1, revision: "abcdef1234", deployedAt: "2026-08-20T00:00:00Z" }],
    },
  }
}
const platformApp = fakeApp("platform-app", "platform", "platform-system")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app")

function req() {
  return new Request("http://localhost/api/events")
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
  vi.mocked(getAlerts).mockResolvedValue([])
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/events — scope enforcement", () => {
  it("does not leak another team's deploy events to a cross-scope caller", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    const titles = body.map((e: { title: string }) => e.title)
    expect(titles).toContain("frontend-app")
    expect(titles).not.toContain("platform-app")
  })

  it("returns the caller's own team events (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    const titles = body.map((e: { title: string }) => e.title)
    expect(titles).toContain("platform-app")
    expect(titles).not.toContain("frontend-app")
  })

  it("keys the cache by scope fingerprint, not one shared literal key", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    await GET(req())
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    await GET(req())
    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0])
    expect(new Set(setKeys).size).toBe(2)
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(req())
    expect(res.status).toBe(401)
  })
})
