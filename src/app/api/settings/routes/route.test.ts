import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }))
vi.mock("@/lib/apisix-client", () => ({ getRoutes: vi.fn(), toggleRoute: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn().mockResolvedValue(null), cacheSet: vi.fn() }))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireAdmin } = await import("@/lib/auth")
const { toggleRoute } = await import("@/lib/apisix-client")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { PATCH } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue({ session: {} } as never)
  vi.mocked(toggleRoute).mockResolvedValue(undefined)
})

describe("PATCH /api/settings/routes", () => {
  it("invalidates after a successful toggle", async () => {
    const req = new NextRequest("http://localhost/api/settings/routes", { method: "PATCH", body: JSON.stringify({ id: "route-1", enable: false }) })
    expect((await PATCH(req)).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("apisix.route.changed", { routeId: "route-1" })
  })

  it("does not invalidate after a failed toggle", async () => {
    vi.mocked(toggleRoute).mockRejectedValue(new Error("upstream failed"))
    const req = new NextRequest("http://localhost/api/settings/routes", { method: "PATCH", body: JSON.stringify({ id: "route-1", enable: false }) })
    expect((await PATCH(req)).status).toBe(500)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})
