import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/cluster-registry", () => ({
  getCluster: vi.fn(),
  resolveClusterCredentials: vi.fn(),
  clusterCacheKey: vi.fn(() => "cluster:test"),
  DEFAULT_CLUSTER_ID: "default",
}))

import { requireRole } from "@/lib/auth"
import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/cluster")

describe("GET /api/cluster role gate (portal#33)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  it("returns 401 without a session and never touches the cluster", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 403 for a role outside the viewer set", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" } as never)
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
})
