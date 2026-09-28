import { beforeEach, describe, expect, it, vi } from "vitest"

// portal#53 AC-4: /api/tools/health keys its cache by `role` (cacheKeys.toolsHealth,
// CACHE_NAMESPACES["tools:health"].securitySensitive: true — "Tool visibility/health
// differs by role") but had no route-level leakage test. getToolsForRole gates
// admin-only tools (e.g. "prometheus") out of the response for non-admin roles, so a
// cluster-admin's cached health blob (which includes a "prometheus" key) reaching a
// viewer would be a real leak, not just a cosmetic difference. This uses the real
// cache-key builder and a real in-memory cacheGet/cacheSet store (mocking only the
// valkey boundary and outbound fetch), same convention as
// src/app/api/governance/dora/route.test.ts.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))

const { auth } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { GET } = await import("./route")

const adminSession = { user: { role: "cluster-admin" } }
const viewerSession = { user: { role: "viewer" } }

beforeEach(() => {
  vi.clearAllMocks()
  const cache = new Map<string, unknown>()
  vi.mocked(cacheGet).mockImplementation(async (key: string) => cache.get(key) ?? null)
  vi.mocked(cacheSet).mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, value)
  })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }))
})

describe("GET /api/tools/health — role scope enforcement", () => {
  it("never serves cluster-admin's cached tool health (which includes admin-only tools) to a viewer", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const adminRes = await GET()
    const adminBody = await adminRes.json()
    // Admin-only tool (roles: ["cluster-admin"]) — sanity check the fixture actually
    // differs by role before asserting isolation.
    expect("prometheus" in adminBody).toBe(true)

    vi.mocked(auth).mockResolvedValue(viewerSession as never)
    const viewerRes = await GET()
    const viewerBody = await viewerRes.json()
    // If admin's cache entry leaked here, "prometheus" would be present.
    expect("prometheus" in viewerBody).toBe(false)

    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0] as string)
    expect(new Set(setKeys).size).toBe(2)
    expect(setKeys).toContain("tools:health:cluster-admin")
    expect(setKeys).toContain("tools:health:viewer")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })
})
