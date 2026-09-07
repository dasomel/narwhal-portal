import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest"

vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}))

import { cacheGet, cacheSet, cacheDel } from "./valkey"
import {
  getUsers,
  getGroups,
  getGroupsDetailed,
  getGroupMembers,
  createUser,
  setUserActive,
  addUserToGroup,
  removeUserFromGroup,
  updateGroupAttributes,
  getKeycloakAdminToken,
  KeycloakCredentialError,
  KeycloakUnavailableError,
} from "./keycloak-client"

describe("keycloak-client pagination and methods", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  // Portal #54: the admin token provider is no longer valkey-backed (it's an
  // in-memory per-process cache, mirroring k8s-token.ts/openbao.ts), so it's
  // primed once here — with a token lifetime long enough to outlive this
  // whole describe block — rather than via the cacheGet mock the pagination
  // tests below don't otherwise care about.
  beforeAll(async () => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = "narwhal-portal-admin"
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "test-admin-secret"
    global.fetch = mockFetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "mock-admin-token", expires_in: 3600 }),
    })
    await getKeycloakAdminToken()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = mockFetch
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("fetches all 250 users across 3 pages (100/100/50) using first=0, 100, 200 sequentially", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `u-${i}`,
      username: `user-${i}`,
      email: `user-${i}@example.com`,
      firstName: "User",
      lastName: `${i}`,
      enabled: true,
    }))
    const page2 = Array.from({ length: 100 }, (_, i) => ({
      id: `u-${i + 100}`,
      username: `user-${i + 100}`,
      email: `user-${i + 100}@example.com`,
      firstName: "User",
      lastName: `${i + 100}`,
      enabled: true,
    }))
    const page3 = Array.from({ length: 50 }, (_, i) => ({
      id: `u-${i + 200}`,
      username: `user-${i + 200}`,
      email: `user-${i + 200}@example.com`,
      firstName: "User",
      lastName: `${i + 200}`,
      enabled: true,
    }))

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page3,
      })

    const users = await getUsers()

    expect(users).toHaveLength(250)
    expect(mockFetch).toHaveBeenCalledTimes(3)
    const call0Url = mockFetch.mock.calls[0][0] as string
    const call1Url = mockFetch.mock.calls[1][0] as string
    const call2Url = mockFetch.mock.calls[2][0] as string

    expect(call0Url).toContain("/admin/realms/narwhal/users?first=0&max=100")
    expect(call1Url).toContain("/admin/realms/narwhal/users?first=100&max=100")
    expect(call2Url).toContain("/admin/realms/narwhal/users?first=200&max=100")
    expect(users[0].pk).toBe("u-0")
    expect(users[249].pk).toBe("u-249")
    expect(cacheSet).toHaveBeenCalledWith("keycloak:users", users, 300)
  })

  it("stops after fetching second page when first page has exactly 100 users and second page is empty", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `u-${i}`,
      username: `user-${i}`,
      email: `user-${i}@example.com`,
      enabled: true,
    }))
    const page2: Record<string, unknown>[] = []

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2,
      })

    const users = await getUsers()

    expect(users).toHaveLength(100)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const call0Url = mockFetch.mock.calls[0][0] as string
    const call1Url = mockFetch.mock.calls[1][0] as string
    expect(call0Url).toContain("/admin/realms/narwhal/users?first=0&max=100")
    expect(call1Url).toContain("/admin/realms/narwhal/users?first=100&max=100")
  })

  it("throws when res.ok is false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    await expect(getUsers()).rejects.toThrow("Keycloak API 500")
  })

  it("returns cached users without fetching if cache hit", async () => {
    const cachedUsers = [
      {
        pk: "cached-1",
        username: "cached",
        email: "cached@example.com",
        name: "Cached",
        is_active: true,
        last_login: null,
      },
    ]
    vi.mocked(cacheGet).mockImplementation(async (key: string) => {
      if (key === "keycloak:users") return cachedUsers
      if (key === "keycloak:admin-token") return "mock-admin-token"
      return null
    })

    const users = await getUsers()
    expect(users).toEqual(cachedUsers)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("paginates getGroups across multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, name: `group-${i}` }))
    const page2 = [{ id: "g-100", name: "group-100" }]

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2,
      })

    const groups = await getGroups()
    expect(groups).toHaveLength(101)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toContain("/admin/realms/narwhal/groups?first=0&max=100")
    expect(mockFetch.mock.calls[1][0]).toContain("/admin/realms/narwhal/groups?first=100&max=100")
    expect(cacheSet).toHaveBeenCalledWith("keycloak:groups", groups, 60)
  })

  it("paginates getGroupMembers correctly", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `m-${i}`,
      username: `member-${i}`,
      email: `m-${i}@example.com`,
    }))
    const page2 = [{ id: "m-100", username: "member-100", email: "m-100@example.com" }]

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2,
      })

    const members = await getGroupMembers("group-xyz")
    expect(members).toHaveLength(101)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toContain("/admin/realms/narwhal/groups/group-xyz/members?first=0&max=100")
    expect(mockFetch.mock.calls[1][0]).toContain("/admin/realms/narwhal/groups/group-xyz/members?first=100&max=100")
  })

  it("fetches getGroupsDetailed in batches and resolves members for each group", async () => {
    const groupList = Array.from({ length: 12 }, (_, i) => ({
      id: `grp-${i}`,
      name: `Group ${i}`,
      attributes: { role: [`role-${i}`] },
    }))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => groupList,
    })

    for (let i = 0; i < 12; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: `user-for-${i}` }],
      })
    }

    const detailed = await getGroupsDetailed()
    expect(detailed).toHaveLength(12)
    expect(detailed[0].users).toEqual(["user-for-0"])
    expect(detailed[11].users).toEqual(["user-for-11"])
    expect(detailed[0].attributes).toEqual({ role: "role-0" })
    expect(cacheSet).toHaveBeenCalledWith("keycloak:groups-detailed", detailed, 60)
  })

  it("createUser creates a user and invalidates keycloak:users cache", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ Location: "http://localhost/admin/realms/narwhal/users/new-user-123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "new-user-123",
          username: "newuser",
          email: "new@example.com",
          firstName: "New",
          lastName: "User",
          enabled: true,
        }),
      })

    const user = await createUser({
      username: "newuser",
      email: "new@example.com",
      name: "New User",
      password: "secretpassword",
    })

    expect(user.pk).toBe("new-user-123")
    expect(cacheDel).toHaveBeenCalledWith("keycloak:users")
  })

  it("setUserActive updates user status and invalidates keycloak:users cache", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
    })

    await setUserActive("user-123", false)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/admin/realms/narwhal/users/user-123"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      })
    )
    expect(cacheDel).toHaveBeenCalledWith("keycloak:users")
  })

  it("addUserToGroup invalidates keycloak:groups-detailed and keycloak:users caches", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
    })

    await addUserToGroup("group-123", "user-456")

    expect(cacheDel).toHaveBeenCalledWith("keycloak:groups-detailed")
    expect(cacheDel).toHaveBeenCalledWith("keycloak:users")
  })

  it("removeUserFromGroup invalidates keycloak:groups-detailed and keycloak:users caches", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
    })

    await removeUserFromGroup("group-123", "user-456")

    expect(cacheDel).toHaveBeenCalledWith("keycloak:groups-detailed")
    expect(cacheDel).toHaveBeenCalledWith("keycloak:users")
  })

  it("updateGroupAttributes invalidates keycloak:groups and keycloak:groups-detailed caches", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "group-123",
          name: "Engineers",
          attributes: { env: ["dev"] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
      })

    await updateGroupAttributes("group-123", { env: "prod" })

    expect(cacheDel).toHaveBeenCalledWith("keycloak:groups")
    expect(cacheDel).toHaveBeenCalledWith("keycloak:groups-detailed")
  })
})

// Portal #54: getKeycloakAdminToken()'s own token-provider behavior — cache
// reuse, 80%-lifetime expiry, in-flight dedup, prod fail-fast, and error-type
// classification. Uses vi.useFakeTimers() + a per-test clock jump (rather than
// vi.resetModules()) to defeat the in-memory admin-token cache between tests,
// mirroring openbao.test.ts's "openbao Kubernetes auth token provider" block —
// getKeycloakAdminToken/getUsers read env at call time, so no module reset is
// needed, only a clock far enough ahead that any previous test's token
// (max lifetime*0.8 = 2880s) is unambiguously expired.
describe("getKeycloakAdminToken — token provider", () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const mockFetch = vi.fn()
  let clockStep = 0

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = "narwhal-portal-admin"
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "test-admin-secret"
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)

    vi.useFakeTimers()
    clockStep += 1
    vi.setSystemTime(new Date(2030, 0, 1).getTime() + clockStep * 10_000_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it("fetches a token via client_credentials against the admin realm", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "tok-1", expires_in: 3600 }),
    })

    const token = await getKeycloakAdminToken()

    expect(token).toBe("tok-1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain("/realms/narwhal/protocol/openid-connect/token")
    const body = new URLSearchParams((init as RequestInit).body as string)
    expect(body.get("grant_type")).toBe("client_credentials")
    expect(body.get("client_id")).toBe("narwhal-portal-admin")
    expect(body.get("client_secret")).toBe("test-admin-secret")
  })

  it("reuses the cached token without re-fetching", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok-1", expires_in: 3600 }),
    })

    const first = await getKeycloakAdminToken()
    const second = await getKeycloakAdminToken()

    expect(first).toBe("tok-1")
    expect(second).toBe("tok-1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("re-fetches once the cached token passes 80% of expires_in", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-1", expires_in: 10 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-2", expires_in: 10 }) })

    const first = await getKeycloakAdminToken()
    expect(first).toBe("tok-1")

    // 80% of a 10s lifetime is 8s; 9s puts us past expiry.
    vi.advanceTimersByTime(9_000)
    const second = await getKeycloakAdminToken()

    expect(second).toBe("tok-2")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("collapses concurrent cold-cache callers into a single fetch", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok-shared", expires_in: 3600 }),
    })

    const tokens = await Promise.all([
      getKeycloakAdminToken(),
      getKeycloakAdminToken(),
      getKeycloakAdminToken(),
    ])

    expect(tokens).toEqual(["tok-shared", "tok-shared", "tok-shared"])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("retries a downstream 401 once via a forced-refresh admin token, then succeeds", async () => {
    let tokenCalls = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/protocol/openid-connect/token")) {
        tokenCalls += 1
        return { ok: true, json: async () => ({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }) }
      }
      if (url.includes("/admin/realms/narwhal/users")) {
        // First attempt (tok-1) is rejected; only the retry (tok-2, post force-refresh) succeeds.
        if (tokenCalls < 2) return { ok: false, status: 401 }
        return { ok: true, json: async () => [] }
      }
      throw new Error(`unexpected fetch to ${url}`)
    })

    const users = await getUsers()

    expect(users).toEqual([])
    expect(tokenCalls).toBe(2)
  })

  it("throws KeycloakCredentialError (not KeycloakUnavailableError) when the token endpoint rejects the credential", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    await expect(getKeycloakAdminToken()).rejects.toBeInstanceOf(KeycloakCredentialError)
  })

  it("throws KeycloakUnavailableError (not KeycloakCredentialError) on a 5xx from the token endpoint", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 })

    await expect(getKeycloakAdminToken()).rejects.toBeInstanceOf(KeycloakUnavailableError)
  })

  it("throws KeycloakUnavailableError on a network failure reaching the token endpoint", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"))

    await expect(getKeycloakAdminToken()).rejects.toBeInstanceOf(KeycloakUnavailableError)
  })

  it("throws KeycloakCredentialError in production when the admin client id/secret are not configured, and never falls back to KEYCLOAK_ADMIN_TOKEN", async () => {
    delete process.env.KEYCLOAK_ADMIN_CLIENT_ID
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
    process.env.KEYCLOAK_ADMIN_TOKEN = "should-never-be-used-in-prod"
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"

    await expect(getKeycloakAdminToken()).rejects.toBeInstanceOf(KeycloakCredentialError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("uses KEYCLOAK_ADMIN_TOKEN as a dev-only fallback when the client id/secret are not configured", async () => {
    delete process.env.KEYCLOAK_ADMIN_CLIENT_ID
    delete process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
    process.env.KEYCLOAK_ADMIN_TOKEN = "dev-static-token"
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"

    const token = await getKeycloakAdminToken()

    expect(token).toBe("dev-static-token")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("never includes the client secret or the admin token in a thrown error message", async () => {
    const SECRET = "super-secret-value-must-not-leak"
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = SECRET
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })

    try {
      await getKeycloakAdminToken()
      throw new Error("expected getKeycloakAdminToken to reject")
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET)
    }

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "leaked-token-value", expires_in: 3600 }) })
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    await getKeycloakAdminToken()
    await expect(getUsers()).rejects.not.toThrow(/leaked-token-value/)
  })
})
