import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { NamespaceInfo, ResourceEvent } from "@/lib/k8s-client"

// /api/k8s/events read the cache and called getResourceEvents on any caller-supplied
// namespace without checking scope, while sibling routes (/api/k8s/pods,
// /api/k8s/resource) already gate via assertK8sNamespace -> getEffectiveScope ->
// namespaceVisible. See src/app/api/k8s/pods/route.test.ts for the mocking rationale
// (auth mocked wholesale; scope.ts left real).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheGetWithMeta: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn(), getResourceEvents: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheGetWithMeta, cacheSet } = await import("@/lib/valkey")
const { getNamespaces, getResourceEvents } = await import("@/lib/k8s-client")
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

const events: ResourceEvent[] = [
  {
    type: "Normal",
    reason: "Scheduled",
    message: "assigned to node-1",
    count: 1,
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-01T00:00:00Z",
  },
]

function req(namespace: string, name = "pod-1") {
  return new NextRequest(`http://localhost/api/k8s/events?namespace=${namespace}&name=${name}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getResourceEvents).mockResolvedValue(events)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheGetWithMeta).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/k8s/events — scope enforcement", () => {
  it("403s a cross-namespace request outside the caller's team scope, without touching cache or upstream", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(cacheGet).not.toHaveBeenCalled()
    expect(getResourceEvents).not.toHaveBeenCalled()
  })

  it("200s a request for the caller's own namespace (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.events).toEqual(events)
    expect(body.freshness.source).toBe("live")
    expect(getResourceEvents).toHaveBeenCalledWith("platform-system", "pod-1")
  })

  it("reports the original capture time for cached events", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(cacheGetWithMeta).mockResolvedValueOnce({
      value: events, cachedAt: "2026-09-27T00:00:00.000Z", ageSeconds: 86_400,
    })
    const body = await (await GET(req("platform-system"))).json()
    expect(body.freshness).toEqual({ source: "cache", observedAt: "2026-09-27T00:00:00.000Z" })
    expect(body.events).toEqual(events)
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
    expect(getResourceEvents).toHaveBeenCalledWith("frontend-app", "pod-1")
  })

  it("403s a caller with no team mapping and no role default (unscoped non-admin)", async () => {
    vi.mocked(auth).mockResolvedValue(unscopedSession as never)
    const res = await GET(req("platform-system"))
    expect(res.status).toBe(403)
    expect(getResourceEvents).not.toHaveBeenCalled()
  })

  it("400s a missing namespace param, unchanged from before the scope gate", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(new NextRequest("http://localhost/api/k8s/events?name=pod-1"))
    expect(res.status).toBe(400)
  })

  it("400s a missing name param, unchanged from before the scope gate", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(new NextRequest("http://localhost/api/k8s/events?namespace=platform-system"))
    expect(res.status).toBe(400)
  })
})
