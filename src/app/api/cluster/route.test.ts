import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheGetWithMeta: vi.fn(), cacheSet: vi.fn() }))
// clusterCacheKey/DEFAULT_CLUSTER_ID are left real (see the leak test below) — only the
// registry lookups and credential resolution are mocked.
vi.mock("@/lib/cluster-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cluster-registry")>()
  return { ...actual, getCluster: vi.fn(), resolveClusterCredentials: vi.fn() }
})

import { requireRole } from "@/lib/auth"
import { cacheGetWithMeta, cacheSet } from "@/lib/valkey"
import { getCluster, resolveClusterCredentials } from "@/lib/cluster-registry"
import { GET } from "./route"

const req = (clusterId?: string) =>
  new NextRequest(`http://localhost/api/cluster${clusterId ? `?cluster_id=${clusterId}` : ""}`)

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

// portal#53 AC-4: clusterCacheKey(clusterId, "infra") (CACHE_NAMESPACES["cluster:{id}:infra"],
// securitySensitive: true) is exercised above only through a fixed literal mock
// ("cluster:test"), so no test here ever proved two different cluster_ids actually get
// different keys, or that one cluster's cached infra can't be returned for another. This
// block uses the REAL clusterCacheKey builder and a real in-memory cacheGetWithMeta/
// cacheSet store (mocking only the registry lookup, credential resolution, and the
// outbound k8s fetch), matching the convention in src/lib/cost.test.ts.
describe("GET /api/cluster — cross-cluster cache isolation (portal#53 AC-4)", () => {
  const cache = new Map<string, unknown>()

  beforeEach(() => {
    vi.clearAllMocks()
    cache.clear()
    vi.mocked(requireRole).mockResolvedValue({ session: {} } as never)
    vi.mocked(cacheGetWithMeta).mockImplementation(async (key: string) => {
      const value = cache.get(key)
      return value === undefined ? null : { value, cachedAt: "2026-09-27T00:00:00.000Z", ageSeconds: 0 }
    })
    vi.mocked(cacheSet).mockImplementation(async (key: string, value: unknown) => {
      cache.set(key, value)
    })
    vi.mocked(getCluster).mockImplementation(async (id: string) => ({ id }) as never)
    vi.mocked(resolveClusterCredentials).mockImplementation(
      (cluster: { id: string }) => ({ apiServer: `https://${cluster.id}.example`, token: "" }) as never
    )
    globalThis.fetch = vi.fn(async (url: string) => {
      // Distinct node counts per cluster so a leak would be observable, not just a
      // cache-key string mismatch.
      if (url.startsWith("https://cluster-a.example/api/v1/nodes")) {
        return new Response(JSON.stringify({ items: [{ metadata: { name: "a-node-1", creationTimestamp: "2026-01-01T00:00:00Z" }, status: { conditions: [{ type: "Ready", status: "True" }], allocatable: { cpu: "1", memory: "1Gi" }, nodeInfo: { kubeletVersion: "v1", osImage: "os" } } }] }), { status: 200 })
      }
      if (url.startsWith("https://cluster-b.example/api/v1/nodes")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
  })

  it("never returns cluster A's cached infra summary for cluster B", async () => {
    const bodyA = await (await GET(req("cluster-a"))).json()
    expect(bodyA.freshness.source).toBe("live")
    expect(bodyA.summary.totalNodes).toBe(1)

    const bodyB = await (await GET(req("cluster-b"))).json()
    expect(bodyB.freshness.source).toBe("live")
    // If cluster-a's cache entry leaked under cluster-b's key, this would be 1.
    expect(bodyB.summary.totalNodes).toBe(0)

    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0] as string)
    expect(setKeys).toEqual(expect.arrayContaining(["cluster:cluster-a:infra", "cluster:cluster-b:infra"]))
    expect(new Set(setKeys).size).toBe(2)

    // Re-request cluster A: must hit its own cache entry, not cluster B's.
    const cachedBodyA = await (await GET(req("cluster-a"))).json()
    expect(cachedBodyA.freshness.source).toBe("cache")
    expect(cachedBodyA.summary.totalNodes).toBe(1)
  })
})
