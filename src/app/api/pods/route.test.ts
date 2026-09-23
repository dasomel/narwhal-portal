import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#33: GET /api/pods (used by the Catalog pod-logs viewer to list a service's
// pods) accepted any caller-supplied namespace with no visibility check at all — no
// role gate, no scope gate. Same fix and same mocking rationale as
// src/app/api/k8s/pods/route.test.ts: @/lib/auth mocked wholesale, @/lib/scope left
// real so this exercises the actual getVisibilityScope/namespaceVisible resolution.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }
const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }
const unscopedSession = { groups: [], teams: [], user: { role: "guest" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

function k8sPodListResponse() {
  return {
    ok: true,
    json: async () => ({
      items: [
        {
          metadata: { name: "pod-1", namespace: "platform-system" },
          spec: { nodeName: "node-1", containers: [{ name: "app" }] },
          status: { phase: "Running" },
        },
      ],
    }),
  } as Response
}

function req(namespace: string) {
  return new Request(`http://localhost/api/pods?namespace=${namespace}`)
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  fetchSpy = vi.fn().mockResolvedValue(k8sPodListResponse())
  vi.stubGlobal("fetch", fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/pods — scope enforcement", () => {
  it("403s a cross-namespace request outside the caller's team scope", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("200s a request for the caller's own namespace (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pods).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(401)
  })

  it("200s cluster-admin reading a namespace no team mapping grants them (fleet visibility)", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await GET(req("frontend-app"))
    expect(res.status).toBe(200)
  })

  it("403s a caller with no team mapping and no role default (unscoped non-admin)", async () => {
    vi.mocked(auth).mockResolvedValue(unscopedSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("keys the cache per-namespace so one namespace's cached pods never answer another's request", async () => {
    vi.mocked(cacheGet).mockImplementation(async (key: string) => {
      if (key === "pods:list:platform-system:all") return [{ name: "cached-platform", namespace: "platform-system", status: "Running", containers: [], nodeName: "n1" }]
      return null
    })
    vi.mocked(auth).mockResolvedValue(adminSession as never)

    const platformRes = await GET(req("platform-system"))
    const frontendRes = await GET(req("frontend-app"))

    expect((await platformRes.json()).pods[0].name).toBe("cached-platform")
    // frontend-app missed the cache and went to the (mocked) K8s API instead —
    // it never saw platform-system's cached entry.
    expect((await frontendRes.json()).pods[0].name).toBe("pod-1")
  })

  it("400s an invalid namespace before authorizing on it", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await GET(req("platform-system%2F..%2Fiam"))
    expect(res.status).toBe(400)
  })
})
