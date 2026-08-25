import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"

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
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  }
}

const platformApp = fakeApp("platform-app", "platform", "platform-system")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app")

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
})

describe("GET /api/argocd — scope enforcement", () => {
  it("returns only frontend apps and summary counts to the frontend team", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)

    const res = await GET()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apps.map((app: { name: string }) => app.name)).toEqual(["frontend-app"])
    expect(body.summary).toMatchObject({ total: 1, synced: 1, outOfSync: 0, degraded: 0 })
  })

  it("returns the platform team's visible app", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)

    const res = await GET()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apps.map((app: { name: string }) => app.name)).toEqual(["platform-app"])
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)

    const res = await GET()

    expect(res.status).toBe(401)
  })
})
