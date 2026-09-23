import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { NamespaceInfo, PodDetail } from "@/lib/k8s-client"

// portal#33: /api/k8s/resource has the same cross-namespace gate as /api/k8s/pods
// (assertK8sNamespace -> getEffectiveScope -> namespaceVisible) but had no
// route-level test. See src/app/api/k8s/pods/route.test.ts / catalog/route.test.ts
// for the mocking rationale.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn(), getPodDetail: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces, getPodDetail } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }
const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }
// No role/team claim resolves to role-filter.ts's branch 4 (guest / no mapping):
// hasMapping=false, namespaces=[] — denied regardless of which namespace is asked for.
const unscopedSession = { groups: [], teams: [], user: { role: "guest" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

const podDetail: PodDetail = {
  name: "pod-1",
  namespace: "platform-system",
  phase: "Running",
  podIP: "10.0.0.1",
  node: "node-1",
  qosClass: "BestEffort",
  serviceAccount: "default",
  createdAt: "2026-01-01T00:00:00Z",
  labels: {},
  owner: null,
  containers: [],
  conditions: [],
}

function req(namespace: string, name = "pod-1") {
  return new NextRequest(`http://localhost/api/k8s/resource?kind=Pod&namespace=${namespace}&name=${name}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getPodDetail).mockResolvedValue(podDetail)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/k8s/resource — scope enforcement", () => {
  it("403s a cross-namespace pod-detail request outside the caller's team scope", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(getPodDetail).not.toHaveBeenCalled()
  })

  it("200s a request for the caller's own namespace (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(podDetail)
    expect(getPodDetail).toHaveBeenCalledWith("platform-system", "pod-1")
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
    expect(getPodDetail).toHaveBeenCalledWith("frontend-app", "pod-1")
  })

  it("403s a caller with no team mapping and no role default (unscoped non-admin)", async () => {
    vi.mocked(auth).mockResolvedValue(unscopedSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(getPodDetail).not.toHaveBeenCalled()
  })

  it("keys the cache per-namespace so one namespace's cached detail never answers another's request", async () => {
    const frontendDetail: PodDetail = { ...podDetail, namespace: "frontend-app" }
    vi.mocked(cacheGet).mockImplementation(async (key: string) => {
      if (key === "k8s:resource:platform-system:pod-1") return podDetail
      if (key === "k8s:resource:frontend-app:pod-1") return frontendDetail
      return null
    })
    vi.mocked(auth).mockResolvedValue(adminSession as never)

    const platformRes = await GET(req("platform-system"))
    const frontendRes = await GET(req("frontend-app"))

    expect(await platformRes.json()).toEqual(podDetail)
    expect(await frontendRes.json()).toEqual(frontendDetail)
    // Both served from cache — the upstream detail call never ran for either namespace.
    expect(getPodDetail).not.toHaveBeenCalled()
  })
})
