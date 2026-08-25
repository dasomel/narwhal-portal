import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { NamespaceInfo, PodSummary } from "@/lib/k8s-client"

// portal#33: /api/k8s/pods gates cross-namespace reads via
// assertK8sNamespace -> getEffectiveScope -> namespaceVisible, but had no
// route-level test exercising an out-of-scope namespace request. See
// src/app/api/catalog/route.test.ts for the mocking rationale (auth mocked
// wholesale; scope.ts left real).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn(), getPodsList: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getNamespaces, getPodsList } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const platformTeamSession = { groups: ["developer"], teams: ["platform-team"], user: { role: "developer" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

const pods: PodSummary[] = [
  { name: "pod-1", namespace: "platform-system", phase: "Running", ready: "1/1", restarts: 0, node: "node-1", age: "1d", images: ["nginx:1"] },
]

function req(namespace: string) {
  return new NextRequest(`http://localhost/api/k8s/pods?namespace=${namespace}`)
}

beforeEach(() => {
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getPodsList).mockResolvedValue(pods)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/k8s/pods — scope enforcement", () => {
  it("403s a cross-namespace request outside the caller's team scope", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(getPodsList).not.toHaveBeenCalled()
  })

  it("200s a request for the caller's own namespace (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pods).toEqual(pods)
    expect(getPodsList).toHaveBeenCalledWith("platform-system", undefined)
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(401)
  })
})
