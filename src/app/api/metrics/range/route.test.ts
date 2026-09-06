import { describe, expect, it, vi, beforeEach } from "vitest"

// portal#33: GET /api/metrics/range carries the same "system, not tenant"
// telemetry shape as /api/metrics (see src/app/api/metrics/route.test.ts) and now
// shares the same requireRole(cluster-admin, developer, viewer) gate.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/prometheus", () => ({ queryRange: vi.fn() }))

const { requireRole } = await import("@/lib/auth")
const { queryRange } = await import("@/lib/prometheus")
const { GET } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(queryRange).mockResolvedValue([{ timestamp: 0, value: 1 }])
})

function req(qs = "?metric=cpu") {
  return new Request(`http://localhost/api/metrics/range${qs}`)
}

describe("GET /api/metrics/range — role policy", () => {
  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" })
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(queryRange).not.toHaveBeenCalled()
  })

  it("403s a guest — node/cluster range telemetry is not guest-visible", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(queryRange).not.toHaveBeenCalled()
  })

  it("200s a developer (non-admin, non-guest)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "developer" } } } as never)
    const res = await GET(req())
    expect(res.status).toBe(200)
  })
})
