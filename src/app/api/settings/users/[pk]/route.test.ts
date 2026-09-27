import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }))
vi.mock("@/lib/keycloak-client", () => ({ setUserActive: vi.fn() }))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireAdmin } = await import("@/lib/auth")
const { setUserActive } = await import("@/lib/keycloak-client")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { PATCH } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue({ session: {} } as never)
  vi.mocked(setUserActive).mockResolvedValue(undefined)
})

describe("PATCH /api/settings/users/[pk]", () => {
  it("invalidates after a successful user update", async () => {
    const req = new NextRequest("http://localhost/api/settings/users/11111111-1111-1111-1111-111111111111", { method: "PATCH", body: JSON.stringify({ is_active: false }) })
    expect((await PATCH(req, { params: Promise.resolve({ pk: "11111111-1111-1111-1111-111111111111" }) })).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("iam.changed", { userPk: "11111111-1111-1111-1111-111111111111" })
  })

  it("does not invalidate when Keycloak update fails", async () => {
    vi.mocked(setUserActive).mockRejectedValue(new Error("upstream failed"))
    const req = new NextRequest("http://localhost/api/settings/users/11111111-1111-1111-1111-111111111111", { method: "PATCH", body: JSON.stringify({ is_active: false }) })
    expect((await PATCH(req, { params: Promise.resolve({ pk: "11111111-1111-1111-1111-111111111111" }) })).status).toBe(500)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})
