import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }))
vi.mock("@/lib/cluster-registry", () => ({
  listClusters: vi.fn(), registerCluster: vi.fn(), removeCluster: vi.fn(), resolveClusterCredentials: vi.fn(() => null),
}))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireAdmin } = await import("@/lib/auth")
const { registerCluster, removeCluster } = await import("@/lib/cluster-registry")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { POST, DELETE } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue({ session: {} } as never)
  vi.mocked(registerCluster).mockResolvedValue({ id: "stage", name: "Stage" } as never)
  vi.mocked(removeCluster).mockResolvedValue({ ok: true } as never)
})

describe("cluster registry mutations", () => {
  it("invalidates after successful registration", async () => {
    const req = new NextRequest("http://localhost/api/settings/clusters", { method: "POST", body: JSON.stringify({ id: "stage" }) })
    expect((await POST(req)).status).toBe(201)
    expect(invalidateFor).toHaveBeenCalledWith("cluster.changed", { clusterId: "stage" })
  })

  it("does not invalidate when registration fails", async () => {
    vi.mocked(registerCluster).mockRejectedValue(new Error("failed"))
    const req = new NextRequest("http://localhost/api/settings/clusters", { method: "POST", body: JSON.stringify({ id: "stage" }) })
    expect((await POST(req)).status).toBe(500)
    expect(invalidateFor).not.toHaveBeenCalled()
  })

  it("invalidates after successful removal only", async () => {
    const req = new NextRequest("http://localhost/api/settings/clusters?id=stage", { method: "DELETE" })
    expect((await DELETE(req)).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("cluster.changed", { clusterId: "stage" })
    vi.clearAllMocks()
    vi.mocked(requireAdmin).mockResolvedValue({ session: {} } as never)
    vi.mocked(removeCluster).mockResolvedValue({ ok: false, message: "missing" } as never)
    expect((await DELETE(req)).status).toBe(400)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})
