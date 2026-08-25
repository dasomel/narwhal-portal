import { describe, expect, it, vi, beforeEach } from "vitest"

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
}))
vi.mock("./scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scope")>()
  return { ...actual, getEffectiveScope: vi.fn() }
})

import { cacheGet } from "./valkey"
import { getEffectiveScope, type EffectiveScope } from "./scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
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
