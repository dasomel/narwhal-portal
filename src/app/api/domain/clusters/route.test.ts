import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { Cluster } from "@/types/cluster"

// portal#53 AC-4: GET /api/domain/clusters resolves each cluster through
// clusterCacheKey(cluster.id, "domain") (CACHE_NAMESPACES["cluster:{id}:domain"],
// securitySensitive: true, dimension "cluster") but had no route-level test at all —
// a real gap distinct from /api/cluster's ClusterInfra route. This uses the REAL
// clusterCacheKey builder and a real in-memory cacheGet/cacheSet store (mocking only
// the registry lookups, the network probe, and the valkey boundary) to prove
// cluster A's cached domain projection is never returned for cluster B.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/cluster-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cluster-registry")>()
  return { ...actual, listClusters: vi.fn(), getCluster: vi.fn(), resolveClusterCredentials: vi.fn() }
})
vi.mock("@/lib/domain/cluster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/cluster")>()
  return { ...actual, probeClusterHealth: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { listClusters, getCluster, resolveClusterCredentials } = await import("@/lib/cluster-registry")
const { probeClusterHealth } = await import("@/lib/domain/cluster")
const { GET } = await import("./route")

const session = { user: { role: "developer" } }

function fakeCluster(id: string): Cluster {
  return {
    id,
    name: `Cluster ${id}`,
    environment: "production",
    provider: "on-prem",
    region: null,
    endpointHint: `${id}:6443`,
    credentialRef: { apiServerEnvVar: `${id.toUpperCase()}_API`, tokenEnvVar: `${id.toUpperCase()}_TOKEN` },
    capabilities: { argocd: "supported", metrics: "supported", events: "supported", storage: "supported", rbac: "supported", logs: "supported" },
    status: "unknown",
    registeredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

const clusterA = fakeCluster("cluster-a")
const clusterB = fakeCluster("cluster-b")

function req(clusterId: string) {
  return new NextRequest(`http://localhost/api/domain/clusters?cluster_id=${clusterId}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  const cache = new Map<string, unknown>()
  vi.mocked(auth).mockResolvedValue(session as never)
  vi.mocked(cacheGet).mockImplementation(async (key: string) => cache.get(key) ?? null)
  vi.mocked(cacheSet).mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, value)
  })
  vi.mocked(resolveClusterCredentials).mockReturnValue({ apiServer: "https://cluster", token: "tok" })
  vi.mocked(getCluster).mockImplementation(async (id: string) => (id === clusterA.id ? clusterA : id === clusterB.id ? clusterB : null))
  vi.mocked(probeClusterHealth).mockImplementation(async (apiServer: string) => ({
    // Distinguish clusters by reachability so their projected `health`/capability
    // status genuinely differs — a real leak would show up as identical output.
    reachable: apiServer === "https://cluster" ? true : false,
    authenticated: true,
    versionKnown: true,
    probedAt: "2026-01-01T00:00:00.000Z",
    error: null,
  }))
})

describe("GET /api/domain/clusters — cross-cluster cache isolation", () => {
  it("never returns cluster A's cached domain projection for cluster B", async () => {
    vi.mocked(probeClusterHealth).mockResolvedValueOnce({
      reachable: true, authenticated: true, versionKnown: true, probedAt: "2026-01-01T00:00:00.000Z", error: null,
    })
    const resA = await GET(req("cluster-a"))
    const bodyA = await resA.json()
    expect(bodyA.clusters).toHaveLength(1)
    expect(bodyA.clusters[0].id).toBe("cluster-a")
    expect(bodyA.clusters[0].health).toBe("healthy")

    vi.mocked(probeClusterHealth).mockResolvedValueOnce({
      reachable: false, authenticated: false, versionKnown: false, probedAt: "2026-01-01T00:00:00.000Z", error: "unreachable",
    })
    const resB = await GET(req("cluster-b"))
    const bodyB = await resB.json()
    expect(bodyB.clusters).toHaveLength(1)
    expect(bodyB.clusters[0].id).toBe("cluster-b")
    // If A's cache entry leaked under B's key, this would still be "healthy".
    expect(bodyB.clusters[0].health).toBe("offline")

    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0] as string)
    expect(setKeys).toEqual(expect.arrayContaining(["cluster:cluster-a:domain", "cluster:cluster-b:domain"]))
    expect(new Set(setKeys).size).toBe(2)
  })

  it("lists every registered cluster's own domain object when no cluster_id filter is given", async () => {
    vi.mocked(listClusters).mockResolvedValue([clusterA, clusterB])
    const res = await GET(new NextRequest("http://localhost/api/domain/clusters"))
    const body = await res.json()
    const ids = body.clusters.map((c: { id: string }) => c.id)
    expect(ids).toEqual(["cluster-a", "cluster-b"])
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(req("cluster-a"))
    expect(res.status).toBe(401)
    expect(getCluster).not.toHaveBeenCalled()
  })
})
