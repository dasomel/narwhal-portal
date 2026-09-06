import { describe, expect, it, vi, beforeEach } from "vitest"

// portal#33: GET /api/metrics accepted any authenticated session — guest included —
// despite /api/cost, /api/scorecards and /api/service-graph gating equivalent
// non-tenant-scoped reads behind requireRole(cluster-admin, developer, viewer).
// See src/app/api/nodes/[name]/route.test.ts for the same mocking rationale.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/prometheus", () => ({ getClusterMetrics: vi.fn(), getNodeMetrics: vi.fn() }))

const { requireRole } = await import("@/lib/auth")
const { getClusterMetrics, getNodeMetrics } = await import("@/lib/prometheus")
const { GET } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getClusterMetrics).mockResolvedValue({
    cpu: 42,
    memory: 55,
    nodes: { total: 3, ready: 3 },
    pods: { total: 20, running: 18 },
  })
  vi.mocked(getNodeMetrics).mockResolvedValue([])
})

describe("GET /api/metrics — role policy", () => {
  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getClusterMetrics).not.toHaveBeenCalled()
  })

  it("403s a guest — cluster telemetry is not guest-visible under the documented policy", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(getClusterMetrics).not.toHaveBeenCalled()
  })

  it("200s a viewer (non-admin, non-guest)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "viewer" } } } as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cpu).toBe(42)
  })

  it("200s cluster-admin (fleet visibility retained)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin" } } } as never)
    const res = await GET()
    expect(res.status).toBe(200)
  })
})
