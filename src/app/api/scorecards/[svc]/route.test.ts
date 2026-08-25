import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { ArgoApp } from "@/lib/argocd"
import type { NamespaceInfo } from "@/lib/k8s-client"
import type { ScorecardEvaluation, ScorecardRulesDoc } from "@/lib/scorecard"

// portal#31: /api/scorecards/[svc] has the same by-name scope bypass /api/catalog/[name]
// had (a guessed service id returned full scorecard detail regardless of team
// ownership) — gated on appVisible/getEffectiveScope, but had no route-level test.
// See src/app/api/catalog/route.test.ts for the mocking rationale.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApp: vi.fn() }
})
vi.mock("@/lib/scorecard", () => ({ evaluateService: vi.fn(), loadRules: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { getArgoApp } = await import("@/lib/argocd")
const { evaluateService, loadRules } = await import("@/lib/scorecard")
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
const evaluation: ScorecardEvaluation = {
  serviceId: "platform-app",
  score: 90,
  tier: "gold",
  passed: [],
  failed: [],
  evaluatedAt: "2026-01-01T00:00:00Z",
}
const rulesDoc: ScorecardRulesDoc = { version: 1, rules: [], tiers: { gold: 90, silver: 70, bronze: 50 } }

function params(svc: string) {
  return { params: Promise.resolve({ svc }) }
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getArgoApp).mockImplementation(async (name: string) => (name === "platform-app" ? platformApp : null))
  vi.mocked(evaluateService).mockResolvedValue(evaluation)
  vi.mocked(loadRules).mockResolvedValue(rulesDoc)
})

describe("GET /api/scorecards/[svc] — scope enforcement", () => {
  it("404s a guessed service id outside the caller's scope", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: frontendTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/scorecards/platform-app"), params("platform-app"))
    expect(res.status).toBe(404)
  })

  it("returns detail for a service the caller's team owns (positive control)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: platformTeamSession } as never)
    const res = await GET(new NextRequest("http://localhost/api/scorecards/platform-app"), params("platform-app"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.service.id).toBe("platform-app")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(new NextRequest("http://localhost/api/scorecards/platform-app"), params("platform-app"))
    expect(res.status).toBe(401)
  })
})
