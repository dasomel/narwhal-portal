import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

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
} from "./keycloak-client"

describe("keycloak-client pagination and methods", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = mockFetch
    vi.mocked(cacheGet).mockImplementation(async (key: string) => {
      if (key === "keycloak:admin-token") return "mock-admin-token"
      return null
    })
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
