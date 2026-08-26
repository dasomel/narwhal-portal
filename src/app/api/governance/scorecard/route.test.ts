import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#31: /api/governance/scorecard scopes with appVisible/getEffectiveScope AND
// keys its cache by scope.fingerprint (the cross-tenant cache-poisoning bug fixed
// alongside events:timeline) — but had no route-level test for either. This exercises
// both: cross-scope filtering, and that two different scopes never share a cached
// response (cacheGet/cacheSet are mocked as a no-op store below, so a shared key
// would show up as one scope's result leaking into the other's assertion).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoAppsOrThrow: vi.fn() }
})
vi.mock("@/lib/alertmanager", () => ({ getAlerts: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getArgoAppsOrThrow } = await import("@/lib/argocd")
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
    status: { sync: { status: "Synced" }, health: { status: "Healthy" }, resources: [] },
  }
}
const platformApp = fakeApp("platform-app", "platform", "platform-system")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app")

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoAppsOrThrow).mockResolvedValue([platformApp, frontendApp])
  vi.mocked(getAlerts).mockResolvedValue([])
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/governance/scorecard — scope enforcement", () => {
  it("does not leak another team's scorecard to a cross-scope caller", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const services = body.map((s: { service: string }) => s.service)
    expect(services).toContain("frontend-app")
    expect(services).not.toContain("platform-app")
  })

  it("returns the caller's own team scorecard (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const services = body.map((s: { service: string }) => s.service)
    expect(services).toContain("platform-app")
    expect(services).not.toContain("frontend-app")
  })

  it("keys the cache by scope fingerprint, not one shared literal key", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    await GET()
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    await GET()
    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0])
    expect(new Set(setKeys).size).toBe(2)
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
  })
})

// portal#31 AC: "ArgoCD project and Kubernetes namespace ownership mismatches are
// denied or explicitly flagged" — flagged, not denied: appVisible's OR semantics
// (checked above) are unchanged, this only asserts the new informational field.
describe("GET /api/governance/scorecard — ownership mismatch flag", () => {
  it("flags an app whose project and namespace belong to different teams", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const crossedApp = fakeApp("crossed-app", "platform", "frontend-app")
    vi.mocked(getArgoAppsOrThrow).mockResolvedValue([crossedApp])
    const res = await GET()
    const body = await res.json()
    const entry = body.find((s: { service: string }) => s.service === "crossed-app")
    expect(entry.ownershipMismatch).toEqual({
      project: "platform",
      namespace: "frontend-app",
      projectOwner: "platform-team",
      namespaceOwner: "frontend-team",
    })
  })

  it("does not flag an app whose project and namespace belong to the same team", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET()
    const body = await res.json()
    const entry = body.find((s: { service: string }) => s.service === "platform-app")
    expect(entry.ownershipMismatch).toBeNull()
  })
})
