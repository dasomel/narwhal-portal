import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#31: /api/catalog scopes its ArgoCD reads via appVisible/getEffectiveScope
// (src/lib/scope.ts), but no test exercised the route handler itself with an
// out-of-scope session — the underlying predicates are covered by
// role-filter.test.ts, this covers the route that calls them.
//
// @/lib/auth is mocked wholesale (not partially) because importing the real module
// calls NextAuth(config) at load time, which pulls in a next-auth internal that does
// not resolve under vitest's plain-Node environment (see src/lib/auth.test.ts).
// @/lib/scope is left real: getVisibilityScope/appVisible run against the actual
// config/role-filter.json, so this test exercises the real scope resolution the
// route depends on, not a stand-in for it.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getArgoApps } = await import("@/lib/argocd")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = {
  groups: ["developer"],
  teams: ["platform-team"],
  user: { role: "developer" },
}
const frontendTeamSession = {
  groups: ["developer"],
  teams: ["frontend-team"],
  user: { role: "developer" },
}
const adminSession = {
  groups: ["cluster-admin"],
  teams: [],
  user: { role: "cluster-admin" },
}

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function fakeApp(name: string, project: string, namespace: string): ArgoApp {
  return {
    metadata: { name },
    spec: { project, destination: { namespace } },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  }
}

const platformApp = fakeApp("platform-app", "platform", "platform-system")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app")

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
})

describe("GET /api/catalog — scope enforcement", () => {
  it("does not leak another team's application to a cross-scope caller", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.map((s: { name: string }) => s.name)
    expect(names).toContain("frontend-app")
    expect(names).not.toContain("platform-app")
  })

  it("returns the caller's own team application (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.map((s: { name: string }) => s.name)
    expect(names).toContain("platform-app")
    expect(names).not.toContain("frontend-app")
  })

  it("cluster-admin retains full fleet visibility", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = body.map((s: { name: string }) => s.name)
    expect(names).toEqual(expect.arrayContaining(["platform-app", "frontend-app"]))
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
  })
})
