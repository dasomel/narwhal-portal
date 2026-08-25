import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"
import type { ScorecardEvaluation, ScorecardRulesDoc } from "@/lib/scorecard"

// portal#31: /api/scorecards filters tierCounts + service list through
// appVisible/getEffectiveScope before aggregation, but had no route-level test.
// See src/app/api/catalog/route.test.ts for the mocking rationale.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})
vi.mock("@/lib/scorecard", () => ({ evaluateAll: vi.fn(), loadRules: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { getArgoApps } = await import("@/lib/argocd")
const { evaluateAll, loadRules } = await import("@/lib/scorecard")
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

function fakeEval(serviceId: string): ScorecardEvaluation {
  return { serviceId, score: 90, tier: "gold", passed: [], failed: [], evaluatedAt: "2026-01-01T00:00:00Z" }
}
const rulesDoc: ScorecardRulesDoc = { version: 1, rules: [], tiers: { gold: 90, silver: 70, bronze: 50 } }

function requestUrl() {
  return new NextRequest("http://localhost/api/scorecards")
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
  vi.mocked(evaluateAll).mockResolvedValue([fakeEval("platform-app"), fakeEval("frontend-app")])
  vi.mocked(loadRules).mockResolvedValue(rulesDoc)
})

describe("GET /api/scorecards — scope enforcement", () => {
  it("does not leak another team's scorecard entry to a cross-scope caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(requestUrl())
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.services.map((s: { id: string }) => s.id)
    expect(ids).toContain("frontend-app")
    expect(ids).not.toContain("platform-app")
    expect(body.totalServices).toBe(1)
  })

  it("returns the caller's own team scorecard (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(requestUrl())
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.services.map((s: { id: string }) => s.id)
    expect(ids).toContain("platform-app")
    expect(ids).not.toContain("frontend-app")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(requestUrl())
    expect(res.status).toBe(401)
  })
})
