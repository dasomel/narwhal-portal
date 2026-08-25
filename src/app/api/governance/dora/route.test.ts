import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})
vi.mock("@/lib/gitea", () => ({ getCommitTimestamp: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getArgoApps } = await import("@/lib/argocd")
const { getCommitTimestamp } = await import("@/lib/gitea")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function fakeApp(name: string, project: string, namespace: string, revision: string): ArgoApp {
  return {
    metadata: { name },
    spec: { project, destination: { namespace } },
    status: {
      sync: { status: "Synced" },
      health: { status: "Healthy" },
      history: [{ id: 1, revision, deployedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
    },
  }
}

const platformApp = fakeApp("platform-app", "platform", "platform-system", "platform-revision")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app", "frontend-revision")

beforeEach(() => {
  const cache = new Map<string, unknown>()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
  vi.mocked(getCommitTimestamp).mockResolvedValue(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
  vi.mocked(cacheGet).mockImplementation(async (key) => cache.get(key) ?? null)
  vi.mocked(cacheSet).mockImplementation(async (key, value) => {
    cache.set(key, value)
  })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { result: [] } }) }))
})

describe("GET /api/governance/dora — scope enforcement", () => {
  it("reduces per-app, recent, and deployment totals to the frontend team's app", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.totalDeploys).toBe(1)
    expect(body.perApp.map((app: { app: string }) => app.app)).toEqual(["frontend-app"])
    expect(body.recent.map((deployment: { app: string }) => deployment.app)).toEqual(["frontend-app"])
  })

  it("returns the platform team's own app as a positive control", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.totalDeploys).toBe(1)
    expect(body.perApp.map((app: { app: string }) => app.app)).toEqual(["platform-app"])
    expect(body.recent.map((deployment: { app: string }) => deployment.app)).toEqual(["platform-app"])
  })

  it("keeps sequential platform and frontend responses in separate scope cache entries", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const platformResponse = await GET()
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const frontendResponse = await GET()

    expect((await platformResponse.json()).perApp.map((app: { app: string }) => app.app)).toEqual(["platform-app"])
    expect((await frontendResponse.json()).perApp.map((app: { app: string }) => app.app)).toEqual(["frontend-app"])
    const doraCacheKeys = vi.mocked(cacheSet).mock.calls.map(([key]) => key).filter((key) => key.startsWith("governance:dora:"))
    expect(new Set(doraCacheKeys).size).toBe(2)
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)

    const res = await GET()

    expect(res.status).toBe(401)
  })
})
