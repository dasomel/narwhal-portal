import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ArgoApp } from "@/lib/argocd"

// portal#53 AC-4: /api/my-apps keys its cache by `user` AND `scope` (cacheKeys.myApps,
// dimensions ["user", "scope"] per CACHE_NAMESPACES["my-apps"]) but had no route-level
// leakage test. This exercises the real cache-key builder and a real in-memory
// cacheGet/cacheSet store (mocking only the valkey/provider boundary, same convention as
// src/app/api/governance/dora/route.test.ts) to prove a cached response for one
// user/team is never served to a different user or team. See src/app/api/catalog/route.test.ts
// for the wholesale-auth-mock rationale (@/lib/scope is left real).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})
vi.mock("@/lib/alertmanager", () => ({ getAlerts: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))

const { auth } = await import("@/lib/auth")
const { getArgoApps } = await import("@/lib/argocd")
const { getAlerts } = await import("@/lib/alertmanager")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { cacheKeys } = await import("@/lib/cache-keys")
const { getEffectiveScope } = await import("@/lib/scope")
const { GET } = await import("./route")

const platformUserA = { groups: ["developer"], teams: ["platform-team"], user: { sub: "user-a", role: "developer" } }
const platformUserB = { groups: ["developer"], teams: ["platform-team"], user: { sub: "user-b", role: "developer" } }
// Same user (sub "user-a") as platformUserA — only the team/scope dimension differs, so a
// key collision here can only be explained by the scope dimension being dropped, not by
// the user dimension (which stayed constant) doing the isolating work instead.
const frontendUserA = { groups: ["developer"], teams: ["frontend-team"], user: { sub: "user-a", role: "developer" } }

function fakeApp(name: string, project: string, namespace: string): ArgoApp {
  return {
    metadata: { name },
    spec: { project, destination: { namespace } },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  }
}
const platformApp = fakeApp("platform-app", "platform", "platform-system")
const frontendApp = fakeApp("frontend-app", "apps", "frontend-app")

beforeEach(() => {
  vi.clearAllMocks()
  const cache = new Map<string, unknown>()
  vi.mocked(getArgoApps).mockResolvedValue([platformApp, frontendApp])
  vi.mocked(getAlerts).mockResolvedValue([])
  vi.mocked(cacheGet).mockImplementation(async (key: string) => cache.get(key) ?? null)
  vi.mocked(cacheSet).mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, value)
  })
})

describe("GET /api/my-apps — scope enforcement", () => {
  it("does not leak platform-team's apps to the SAME user on frontend-team, and never serves platform-team's cached entry to it", async () => {
    const platformScope = await getEffectiveScope({ groups: platformUserA.groups, teams: platformUserA.teams })
    const frontendScope = await getEffectiveScope({ groups: frontendUserA.groups, teams: frontendUserA.teams })
    const expectedPlatformKey = cacheKeys.myApps("user-a", platformScope.fingerprint)
    const expectedFrontendKey = cacheKeys.myApps("user-a", frontendScope.fingerprint)

    vi.mocked(auth).mockResolvedValue(platformUserA as never)
    const platformRes = await GET()
    const platformBody = await platformRes.json()
    expect(platformBody.scopedApps.map((a: { name: string }) => a.name)).toEqual(["platform-app"])

    vi.mocked(auth).mockResolvedValue(frontendUserA as never)
    const frontendRes = await GET()
    const frontendBody = await frontendRes.json()
    // Only the team/scope dimension changed between these two calls (same user sub
    // "user-a"). If the scope dimension were dropped from the key, this would come
    // back as platform-team's already-cached response instead of a fresh, correctly
    // scoped one.
    expect(frontendBody.scopedApps.map((a: { name: string }) => a.name)).toEqual(["frontend-app"])
    expect(frontendBody.scopedApps.map((a: { name: string }) => a.name)).not.toContain("platform-app")

    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0] as string)
    expect(setKeys).toEqual([expectedPlatformKey, expectedFrontendKey])
    expect(new Set(setKeys).size).toBe(2)
  })

  it("keys the cache by user even when scope (team) matches, so two teammates never share one cache slot", async () => {
    vi.mocked(auth).mockResolvedValue(platformUserA as never)
    await GET()
    vi.mocked(auth).mockResolvedValue(platformUserB as never)
    await GET()

    const setKeys = vi.mocked(cacheSet).mock.calls.map((c) => c[0] as string)
    expect(setKeys).toHaveLength(2)
    expect(new Set(setKeys).size).toBe(2)
    expect(setKeys[0]).toContain("user-a")
    expect(setKeys[1]).toContain("user-b")
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getArgoApps).not.toHaveBeenCalled()
  })
})
