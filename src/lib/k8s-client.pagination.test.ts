import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// portal#52: Kubernetes / Provider Inventory Pagination and Bounded Queries.
// Same mocking shape as prometheus.test.ts — mock ./config so k8sFetch's
// authHeaders() sees a plain http:// apiServer and never touches k8s-token.ts's
// file-backed bearer token, and mock ./valkey so getNamespaces()/getNamespacesForScope()
// never depend on a real cache.
vi.mock("./config", () => ({
  getK8sApiServer: () => "http://k8s.mock",
}))

const mockCache = new Map<string, unknown>()
vi.mock("./valkey", () => ({
  cacheGet: vi.fn(async (key: string) => mockCache.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, val: unknown) => {
    mockCache.set(key, val)
  }),
}))

import { listBounded, getNamespacesForScope, DEFAULT_LIST_MAX_PAGES, SMALL_SCOPE_NAMESPACE_THRESHOLD } from "./k8s-client"

interface MockItem {
  metadata: { name: string }
}

function pageResponse(names: string[], continueToken?: string) {
  return {
    metadata: continueToken ? { continue: continueToken } : {},
    items: names.map((name) => ({ metadata: { name } })),
  }
}

function namespaceResponse(name: string) {
  return {
    metadata: { name, labels: {}, creationTimestamp: "2026-01-01T00:00:00Z" },
    status: { phase: "Active" },
  }
}

function namespaceListResponse(names: string[]) {
  return {
    metadata: {},
    items: names.map((name) => ({
      metadata: { name, labels: {}, creationTimestamp: "2026-01-01T00:00:00Z" },
      status: { phase: "Active" },
    })),
  }
}

describe("listBounded (portal#52)", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.clear()
    global.fetch = mockFetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("follows metadata.continue across pages until the list is exhausted", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pageResponse(["a", "b"], "tok-1") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pageResponse(["c", "d"], "tok-2") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pageResponse(["e"]) })

    const result = await listBounded<MockItem>("/api/v1/widgets", { limit: 2, maxPages: 10 })

    expect(result.items.map((i) => i.metadata.name)).toEqual(["a", "b", "c", "d", "e"])
    expect(result.truncated).toBe(false)
    expect(result.pages).toBe(3)
    expect(mockFetch).toHaveBeenCalledTimes(3)

    // Each page request carries the server-side limit, and pages after the first
    // carry the continue token from the previous page's response.
    const firstUrl = new URL(mockFetch.mock.calls[0][0] as string)
    expect(firstUrl.searchParams.get("limit")).toBe("2")
    expect(firstUrl.searchParams.has("continue")).toBe(false)
    const secondUrl = new URL(mockFetch.mock.calls[1][0] as string)
    expect(secondUrl.searchParams.get("continue")).toBe("tok-1")
    const thirdUrl = new URL(mockFetch.mock.calls[2][0] as string)
    expect(thirdUrl.searchParams.get("continue")).toBe("tok-2")
  })

  it("stops at maxPages and reports truncated=true when the server still has more (continue set)", async () => {
    // Every page keeps returning a continue token — an unbounded cluster would
    // make listBounded loop forever without the maxPages cap.
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => pageResponse(["x"], "keep-going"),
    }))

    const result = await listBounded<MockItem>("/api/v1/widgets", { limit: 1, maxPages: 3 })

    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.items).toHaveLength(3)
  })

  it("defaults to DEFAULT_LIST_MAX_PAGES when maxPages is not given", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => pageResponse(["x"], "keep-going"),
    }))

    const result = await listBounded<MockItem>("/api/v1/widgets", { limit: 1 })

    expect(mockFetch).toHaveBeenCalledTimes(DEFAULT_LIST_MAX_PAGES)
    expect(result.truncated).toBe(true)
  })
})

describe("getNamespacesForScope (portal#52)", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockCache.clear()
    global.fetch = mockFetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("fetches per-namespace instead of the cluster-wide LIST when the scope is small", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/namespaces/")) {
        const name = url.split("/api/v1/namespaces/")[1]
        return { ok: true, status: 200, json: async () => namespaceResponse(name) }
      }
      throw new Error(`unexpected cluster-wide LIST call: ${url}`)
    })

    const scope = { all: false, namespaces: new Set(["team-a", "team-b"]) }
    const result = await getNamespacesForScope(scope)

    expect(result.map((ns) => ns.name).sort()).toEqual(["team-a", "team-b"])
    // One GET per namespace, no cluster-wide /api/v1/namespaces LIST.
    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const call of mockFetch.mock.calls) {
      expect(call[0]).not.toBe("http://k8s.mock/api/v1/namespaces")
      expect((call[0] as string).startsWith("http://k8s.mock/api/v1/namespaces?")).toBe(false)
    }
  })

  it("falls back to the cluster-wide LIST + filter above the small-scope threshold", async () => {
    const manyNamespaces = Array.from({ length: SMALL_SCOPE_NAMESPACE_THRESHOLD + 1 }, (_, i) => `ns-${i}`)
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("http://k8s.mock/api/v1/namespaces?")) {
        return { ok: true, status: 200, json: async () => namespaceListResponse(manyNamespaces) }
      }
      throw new Error(`unexpected per-namespace call: ${url}`)
    })

    const scope = { all: false, namespaces: new Set(manyNamespaces) }
    const result = await getNamespacesForScope(scope)

    // One cluster-wide LIST call (possibly paginated), not one call per namespace.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(manyNamespaces.length)
  })

  it("uses the cluster-wide LIST for an admin (scope.all) caller", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("http://k8s.mock/api/v1/namespaces?")) {
        return { ok: true, status: 200, json: async () => namespaceListResponse(["ns-a", "ns-b"]) }
      }
      throw new Error(`unexpected per-namespace call: ${url}`)
    })

    const scope = { all: true, namespaces: new Set<string>() }
    const result = await getNamespacesForScope(scope)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.map((ns) => ns.name)).toEqual(["ns-a", "ns-b"])
  })
})

describe("bounded cluster-wide fetch failure semantics (#52 review)", () => {
  it("reports truncated=true, not an empty cluster, when pagination fails in production", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    globalThis.fetch = vi.fn(async () => {
      throw new Error("410 Gone: continue token expired")
    }) as unknown as typeof fetch
    const { getAllPodsMinimal, getAllNodesForDistribution } = await import("./k8s-client")
    for (const fn of [getAllPodsMinimal, getAllNodesForDistribution]) {
      const res = await fn()
      expect(res.items).toEqual([])
      expect(res.truncated).toBe(true)
    }
  })
})
