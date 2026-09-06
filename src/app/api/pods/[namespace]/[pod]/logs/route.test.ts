import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { NamespaceInfo } from "@/lib/k8s-client"

// portal#33: GET /api/pods/[namespace]/[pod]/logs gated WHO could call it
// (ALLOWED_ROLES) but not WHICH namespace's logs they could read — a
// developer/viewer could pull another team's pod logs (env vars, stack traces) by
// naming the namespace directly. Same mocking rationale as
// src/app/api/k8s/pods/route.test.ts: @/lib/auth mocked wholesale, @/lib/scope left
// real.
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

function logsResponse(body = "log line 1\nlog line 2") {
  return { ok: true, text: async () => body } as Response
}

function req(namespace: string, pod = "pod-1") {
  return new Request(`http://localhost/api/pods/${namespace}/${pod}/logs`)
}

function params(namespace: string, pod = "pod-1") {
  return { params: Promise.resolve({ namespace, pod }) }
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  fetchSpy = vi.fn().mockResolvedValue(logsResponse())
  vi.stubGlobal("fetch", fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/pods/[namespace]/[pod]/logs — scope enforcement", () => {
  it("403s a cross-namespace log request outside the caller's team scope", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET(req("platform-system"), params("platform-system"))
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("200s a request for the caller's own namespace (positive control)", async () => {
    vi.mocked(auth).mockResolvedValue(platformTeamSession as never)
    const res = await GET(req("platform-system"), params("platform-system"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.logs).toContain("log line 1")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(req("platform-system"), params("platform-system"))
    expect(res.status).toBe(401)
  })

  it("200s cluster-admin reading a namespace no team mapping grants them (fleet visibility)", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await GET(req("frontend-app"), params("frontend-app"))
    expect(res.status).toBe(200)
  })

  it("403s a caller with no team mapping and no role default (unscoped non-admin)", async () => {
    vi.mocked(auth).mockResolvedValue(unscopedSession as never)
    const res = await GET(req("platform-system"), params("platform-system"))
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("keys the cache per-namespace/pod so one pod's cached logs never answer another namespace's request", async () => {
    vi.mocked(cacheGet).mockImplementation(async (key: string) => {
      if (key === "pods:logs:platform-system:pod-1::200:false") {
        return { logs: "cached platform logs", container: "default", pod: "pod-1", namespace: "platform-system" }
      }
      return null
    })
    vi.mocked(auth).mockResolvedValue(adminSession as never)

    const platformRes = await GET(req("platform-system"), params("platform-system"))
    const frontendRes = await GET(req("frontend-app"), params("frontend-app"))

    expect((await platformRes.json()).logs).toBe("cached platform logs")
    // frontend-app's request missed the cache and hit the (mocked) K8s API instead.
    expect((await frontendRes.json()).logs).toContain("log line 1")
  })
})
