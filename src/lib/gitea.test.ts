vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { cacheGet, cacheSet } from "./valkey"
import {
  tenantManifest,
  tenantPath,
  requestTenantNamespace,
  getCommitTimestamp,
  getGiteaToken,
  GiteaCredentialError,
  GiteaError,
} from "./gitea"

// The live half of this flow — branch push, PR creation, the 409 on a duplicate —
// needs a Gitea to talk to and is verified against a scratch instance by hand; it is
// not asserted here because a CI test that needs a server is a flaky test. What IS
// asserted is the part that is pure and the part that silently matters: the manifest
// a merge applies to the cluster.
describe("tenantPath", () => {
  it("matches the layout the tenants Application recurses over", () =>
    expect(tenantPath("team-a", "dev-alpha")).toBe("resources/tenants/team-a/dev-alpha.yaml"))
})

describe("tenantManifest", () => {
  const m = tenantManifest("dev-alpha", "team-a", "alice@example.com")

  it("labels the namespace with the owning team", () =>
    expect(m).toContain("narwhal.io/team: team-a"))

  // Without this the team can see the namespace and change nothing in it: the
  // cluster-wide `developer` role is read-only by design (narwhal 7551c21).
  it("binds developer-workload-admin, not the read-only developer role", () => {
    expect(m).toContain("name: developer-workload-admin")
    expect(m).not.toMatch(/name: developer$/m)
  })

  it("binds it to the requesting team's OIDC group, not a wildcard", () =>
    expect(m).toContain('name: "oidc:team-a"'))

  it("carries a quota — an unbounded namespace starves its neighbours", () => {
    expect(m).toContain("kind: ResourceQuota")
    expect(m).toContain("requests.memory: 4Gi")
  })

  it("records who asked, since the merge is the audit record", () =>
    expect(m).toContain("alice@example.com"))

  it("is three documents: Namespace, RoleBinding, ResourceQuota", () =>
    expect(m.split(/^---$/m)).toHaveLength(3))
})

describe("gitea credential handling", () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.GITEA_URL = "https://gitea.local:3000"
    process.env.GITEA_OWNER = "gitea-admin"
    process.env.GITEA_REPO = "narwhal-gitops"
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it("throws GiteaCredentialError in production when GITEA_TOKEN is unset for the write path (requestTenantNamespace)", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.GITEA_TOKEN

    await expect(
      requestTenantNamespace({
        namespace: "dev-alpha",
        team: "team-a",
        requestedBy: "alice",
      })
    ).rejects.toBeInstanceOf(GiteaCredentialError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns null (not a throw) in production when GITEA_TOKEN is unset for getCommitTimestamp, and logs it distinctly", async () => {
    // D1 (#54 review): getCommitTimestamp restores its documented "returns null,
    // never throws" contract — the DORA route's Promise.all fan-out over commit
    // shas must not lose every other sha's timestamp because one token is missing.
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.GITEA_TOKEN
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getCommitTimestamp("sha123")).resolves.toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check GITEA_TOKEN"),
      expect.anything(),
    )
  })

  it("picks up GITEA_TOKEN change between calls (rotation without restart)", async () => {
    process.env.GITEA_TOKEN = "token-1"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ commit: { committer: { date: "2026-01-01T00:00:00Z" } } }),
    })

    await getCommitTimestamp("sha123")

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/repos/gitea-admin/narwhal-gitops/git/commits/sha123"),
      expect.objectContaining({
        headers: { Authorization: "token token-1" },
      })
    )

    process.env.GITEA_TOKEN = "token-2"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ commit: { committer: { date: "2026-01-02T00:00:00Z" } } }),
    })

    await getCommitTimestamp("sha456")

    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/v1/repos/gitea-admin/narwhal-gitops/git/commits/sha456"),
      expect.objectContaining({
        headers: { Authorization: "token token-2" },
      })
    )
  })

  it("throws GiteaCredentialError on 401 for the write path (requestTenantNamespace)", async () => {
    process.env.GITEA_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    await expect(
      requestTenantNamespace({
        namespace: "dev-alpha",
        team: "team-a",
        requestedBy: "alice",
      })
    ).rejects.toBeInstanceOf(GiteaCredentialError)
  })

  it("returns null on 401 for getCommitTimestamp (read helper stays non-throwing) and logs it distinctly", async () => {
    process.env.GITEA_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(getCommitTimestamp("sha123")).resolves.toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("check GITEA_TOKEN"),
      expect.anything(),
    )
  })

  it("treats 403 as a permission error (GiteaError), not a credential failure", async () => {
    process.env.GITEA_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => JSON.stringify({ message: "user does not have permission" }),
    })

    const err = await requestTenantNamespace({
      namespace: "dev-alpha",
      team: "team-a",
      requestedBy: "alice",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GiteaError)
    expect(err).not.toBeInstanceOf(GiteaCredentialError)
  })

  it("throws GiteaError (not GiteaCredentialError) on non-auth 5xx error in requestTenantNamespace", async () => {
    process.env.GITEA_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => JSON.stringify({ message: "server broke" }),
    })

    await expect(
      requestTenantNamespace({
        namespace: "dev-alpha",
        team: "team-a",
        requestedBy: "alice",
      })
    ).rejects.toBeInstanceOf(GiteaError)
  })

  it("returns null on non-auth 5xx error in getCommitTimestamp", async () => {
    process.env.GITEA_TOKEN = "some-token"
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const ts = await getCommitTimestamp("sha123")
    expect(ts).toBeNull()
  })

  it("does not include token value in thrown error messages", async () => {
    const secretToken = "super-secret-gitea-token-999"
    process.env.GITEA_TOKEN = secretToken
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    let thrownError: Error | null = null
    try {
      await requestTenantNamespace({
        namespace: "dev-alpha",
        team: "team-a",
        requestedBy: "alice",
      })
    } catch (err) {
      thrownError = err as Error
    }

    expect(thrownError).toBeInstanceOf(GiteaCredentialError)
    expect(thrownError?.message).not.toContain(secretToken)
    expect(thrownError?.message).toContain("GITEA_TOKEN")
  })
})
