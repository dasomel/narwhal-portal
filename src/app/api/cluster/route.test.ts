import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheGetWithMeta: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/cluster-registry", () => ({
  getCluster: vi.fn(),
  resolveClusterCredentials: vi.fn(),
  clusterCacheKey: vi.fn(() => "cluster:test"),
  DEFAULT_CLUSTER_ID: "default",
}))

import { requireRole } from "@/lib/auth"
import { cacheGetWithMeta } from "@/lib/valkey"
import { getCluster, resolveClusterCredentials } from "@/lib/cluster-registry"
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

  it("returns a cached cluster response with its original capture time", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: {} } as never)
    vi.mocked(getCluster).mockResolvedValue({ id: "default" } as never)
    vi.mocked(resolveClusterCredentials).mockReturnValue({ apiServer: "https://cluster", token: "" } as never)
    const cached = {
      nodes: [], controlPlane: [], namespaces: [],
      summary: { totalNodes: 0, readyNodes: 0, totalPods: 0, totalNamespaces: 0, truncated: false },
    }
    vi.mocked(cacheGetWithMeta).mockResolvedValueOnce({ value: cached as never, cachedAt: "2026-09-27T00:00:00.000Z", ageSeconds: 86_400 })
    const body = await (await GET(req())).json()
    expect(body.freshness).toEqual({ source: "cache", observedAt: "2026-09-27T00:00:00.000Z" })
    expect(body.summary).toEqual(cached.summary)
  })

  it("marks a provider response as live", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: {} } as never)
    vi.mocked(getCluster).mockResolvedValue({ id: "default" } as never)
    vi.mocked(resolveClusterCredentials).mockReturnValue({ apiServer: "https://cluster", token: "" } as never)
    vi.mocked(cacheGetWithMeta).mockResolvedValueOnce(null)
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch

    const body = await (await GET(req())).json()
    expect(body.freshness.source).toBe("live")
    expect(body.summary).toMatchObject({ totalNodes: 0, totalPods: 0, totalNamespaces: 0 })
  })
})
