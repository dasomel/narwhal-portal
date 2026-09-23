import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

// assertAppAccessible's two network dependencies get stubbed so this stays a pure
// unit test: cacheGet stands in for the ArgoCD API call (getArgoApp always hits the
// cache path when it hits), and getEffectiveScope stands in for the k8s namespace
// list fetch scope.ts otherwise makes. namespaceVisible/appVisible themselves are
// left real via importOriginal — they are pure and already covered indirectly here.
// Live sync/rollback calls against a real ArgoCD API are verified by hand, same as
// gitea.ts's live half.
vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))
vi.mock("./scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scope")>()
  return { ...actual, getEffectiveScope: vi.fn() }
})

import { cacheGet, cacheSet, cacheDel } from "./valkey"
import { getEffectiveScope, type EffectiveScope } from "./scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  ArgoCDCredentialError,
  getArgoApp,
  getArgoApps,
  getArgoAppsOrThrow,
  getArgoToken,
  syncArgoApp,
  rollbackArgoApp,
  type ArgoActor,
  type ArgoApp,
} from "./argocd"

const mockedCacheGet = vi.mocked(cacheGet)
const mockedGetEffectiveScope = vi.mocked(getEffectiveScope)

function makeApp(project: string, namespace: string): ArgoApp {
  return {
    metadata: { name: "svc" },
    spec: { project, destination: { namespace } },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  }
}

// Mirrors the admin/team/guest fixture shape role-filter.test.ts uses for scopes,
// widened to EffectiveScope's fields (Set instead of array, plus the bookkeeping
// getEffectiveScope callers never inspect directly).
function makeScope(namespaces: string[], argocdProjects: string[] = []): EffectiveScope {
  return {
    all: false,
    namespaces: new Set(namespaces),
    argocdProjects,
    hasMapping: namespaces.length > 0 || argocdProjects.length > 0,
    fingerprint: "test-fingerprint",
    resolved: { all: false, names: new Set(namespaces), byLabel: new Set(namespaces), byPattern: new Set() },
    clusterId: DEFAULT_CLUSTER_ID,
  }
}

const developerOnPlatformTeam: ArgoActor = {
  role: "developer",
  groups: ["platform-team"],
  teams: ["platform-team"],
}

beforeEach(() => {
  mockedCacheGet.mockReset()
  mockedGetEffectiveScope.mockReset()
})

describe("assertAppAccessible", () => {
  it("allows an actor whose project AND destination namespace both match their scope", async () => {
    mockedCacheGet.mockResolvedValue(makeApp("platform", "platform-system"))
    mockedGetEffectiveScope.mockResolvedValue(makeScope(["platform-system"], ["platform"]))

    await expect(assertAppAccessible("svc", developerOnPlatformTeam)).resolves.toMatchObject({
      spec: { project: "platform" },
    })
  })

  it("rejects when the project matches but the destination namespace is outside the actor's team scope", async () => {
    // `tenants` (or any shared project) can host namespaces belonging to other
    // teams — the project check alone must not be sufficient (#37).
    mockedCacheGet.mockResolvedValue(makeApp("platform", "other-team-ns"))
    mockedGetEffectiveScope.mockResolvedValue(makeScope(["platform-system"], ["platform"]))

    await expect(assertAppAccessible("svc", developerOnPlatformTeam)).rejects.toThrow(ArgoForbiddenError)
  })

  it("rejects an actor with no scope at all", async () => {
    mockedCacheGet.mockResolvedValue(makeApp("platform", "platform-system"))
    mockedGetEffectiveScope.mockResolvedValue(makeScope([], []))

    const noScopeActor: ArgoActor = { role: "developer", groups: [], teams: [] }
    await expect(assertAppAccessible("svc", noScopeActor)).rejects.toThrow(ArgoForbiddenError)
    // getAllowedProjects already denies on the project check for a mappingless
    // developer, so getEffectiveScope is never reached in this path.
    expect(mockedGetEffectiveScope).not.toHaveBeenCalled()
  })

  it("cluster-admin bypasses both the project and namespace checks", async () => {
    mockedCacheGet.mockResolvedValue(makeApp("tenants", "someone-elses-ns"))

    const admin: ArgoActor = { role: "cluster-admin" }
    await expect(assertAppAccessible("svc", admin)).resolves.toMatchObject({
      spec: { project: "tenants" },
    })
    expect(mockedGetEffectiveScope).not.toHaveBeenCalled()
  })

  it("throws ArgoNotFoundError when the app does not exist", async () => {
    mockedCacheGet.mockResolvedValue(undefined)
    // getArgoApp falls through to a live fetch on a cache miss; stub global fetch to
    // a 404 so this stays network-free.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response),
    )

    await expect(assertAppAccessible("missing", developerOnPlatformTeam)).rejects.toThrow(ArgoNotFoundError)
    vi.unstubAllGlobals()
  })
})

describe("argocd credential handling", () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.ARGOCD_URL = "http://argocd.local:8080"
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it("returns [] (not a throw) in production when ARGOCD_TOKEN is unset, and logs it distinctly", async () => {
    // D1 (#54 review): read helpers keep their non-throwing contract — the
    // governance/dora and events/route Promise.all fan-outs, and the unguarded
    // architecture/service-graph SSE callers, depend on getArgoApps never
    // rejecting. A credential problem is still surfaced, just via console.error
    // instead of a rejection, so it doesn't look like a plain empty inventory.
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.ARGOCD_TOKEN
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getArgoApps()).resolves.toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check ARGOCD_TOKEN"),
      expect.anything(),
    )
  })

  it("picks up ARGOCD_TOKEN change between calls (rotation without restart)", async () => {
    process.env.ARGOCD_TOKEN = "token-1"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    })

    await getArgoApps()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/applications"),
      expect.objectContaining({
        headers: { Authorization: "Bearer token-1" },
      })
    )

    process.env.ARGOCD_TOKEN = "token-2"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    })

    await getArgoApps()

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/v1/applications"),
      expect.objectContaining({
        headers: { Authorization: "Bearer token-2" },
      })
    )
  })

  it("returns [] on 401 (read helper stays non-throwing) and logs the credential rejection distinctly", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(getArgoApps()).resolves.toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check ARGOCD_TOKEN"),
      expect.anything(),
    )
    // Distinct from the plain-connectivity-failure warn path below.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("returns null on 401 for getArgoApp (read helper stays non-throwing) and logs it distinctly", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getArgoApp("checkout-api")).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check ARGOCD_TOKEN"),
      expect.anything(),
    )
  })

  it("treats 403 as an RBAC denial, not a credential failure (keeps previous behavior)", async () => {
    // A valid token that portal-reader RBAC does not allow for this resource is
    // not "check ARGOCD_TOKEN" — only 401 means the credential itself is bad.
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })

    await expect(getArgoApps()).resolves.toEqual([])
  })

  it("returns [] on a non-auth 5xx error, keeping previous behavior", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const apps = await getArgoApps()
    expect(apps).toEqual([])
  })

  it("returns [] on network failure, keeping previous behavior", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"))

    const apps = await getArgoApps()
    expect(apps).toEqual([])
  })

  it("does not include the token value in the credential-rejection log", async () => {
    const secretToken = "super-secret-argo-jwt-token-999"
    process.env.ARGOCD_TOKEN = secretToken
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const apps = await getArgoApps()

    expect(apps).toEqual([])
    const loggedArgs = errorSpy.mock.calls.flat().map(String)
    expect(loggedArgs.some((a) => a.includes(secretToken))).toBe(false)
    expect(loggedArgs.some((a) => a.includes("ARGOCD_TOKEN"))).toBe(true)
  })

  it("throws ArgoCDCredentialError in production when ARGOCD_TOKEN is unset for sync and rollback", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.ARGOCD_TOKEN

    await expect(syncArgoApp("app-1")).rejects.toBeInstanceOf(ArgoCDCredentialError)
    await expect(rollbackArgoApp("app-1", 1)).rejects.toBeInstanceOf(ArgoCDCredentialError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("throws ArgoCDCredentialError on 401 for sync and rollback", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    await expect(syncArgoApp("app-1")).rejects.toBeInstanceOf(ArgoCDCredentialError)

    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    await expect(rollbackArgoApp("app-1", 1)).rejects.toBeInstanceOf(ArgoCDCredentialError)
  })

  it("does not report a 403 RBAC denial on rollback as a credential error", async () => {
    process.env.ARGOCD_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })
    await expect(rollbackArgoApp("app-1", 1)).resolves.toBe(false)
  })
})
