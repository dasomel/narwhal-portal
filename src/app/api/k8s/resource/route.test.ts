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
})
