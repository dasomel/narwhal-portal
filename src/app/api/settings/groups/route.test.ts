import { describe, expect, it, vi, beforeEach } from "vitest"
import type { KeycloakGroupDetailed, KeycloakUser } from "@/lib/keycloak-client"
import { KEYCLOAK_CACHE_KEYS } from "@/lib/keycloak-client"

const valkeyStore = new Map<string, unknown>()

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
}))

vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn(async (key: string) => valkeyStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, val: unknown) => {
    valkeyStore.set(key, val)
  }),
  cacheDel: vi.fn(async (key: string) => {
    valkeyStore.delete(key)
  }),
}))

vi.mock("@/lib/keycloak-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/keycloak-client")>()
  return {
    ...actual,
    getGroupsDetailed: vi.fn(),
    getUsers: vi.fn(),
    addUserToGroup: vi.fn(async (_groupPk: string, _userPk: string) => {
      await actual.invalidateKeycloakCaches([
        actual.KEYCLOAK_CACHE_KEYS.groupsDetailed,
        actual.KEYCLOAK_CACHE_KEYS.users,
        actual.KEYCLOAK_CACHE_KEYS.groupsEnriched,
      ])
    }),
    removeUserFromGroup: vi.fn(async (_groupPk: string, _userPk: string) => {
      await actual.invalidateKeycloakCaches([
        actual.KEYCLOAK_CACHE_KEYS.groupsDetailed,
        actual.KEYCLOAK_CACHE_KEYS.users,
        actual.KEYCLOAK_CACHE_KEYS.groupsEnriched,
      ])
    }),
    updateGroupAttributes: vi.fn(async (_groupPk: string, _attrs: Record<string, unknown>) => {
      await actual.invalidateKeycloakCaches([
        actual.KEYCLOAK_CACHE_KEYS.groups,
        actual.KEYCLOAK_CACHE_KEYS.groupsDetailed,
        actual.KEYCLOAK_CACHE_KEYS.groupsEnriched,
      ])
    }),
  }
})

const { requireAdmin } = await import("@/lib/auth")
const {
  getGroupsDetailed,
  getUsers,
  addUserToGroup,
  removeUserFromGroup,
  updateGroupAttributes,
} = await import("@/lib/keycloak-client")
const { cacheGet, cacheSet, cacheDel } = await import("@/lib/valkey")
const { GET, PATCH } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }

const user1: KeycloakUser = {
  pk: "user-1",
  username: "alice",
  email: "alice@example.com",
  name: "Alice",
  is_active: true,
  last_login: null,
}

const user2: KeycloakUser = {
  pk: "user-2",
  username: "bob",
  email: "bob@example.com",
  name: "Bob",
  is_active: true,
  last_login: null,
}

const initialGroup: KeycloakGroupDetailed = {
  pk: "grp-1",
  name: "Platform Engineers",
  num_pk: 0,
  is_superuser: false,
  parent: null,
  parent_name: null,
  users: ["user-1"],
  attributes: { env: ["dev"] },
  roles_obj: [],
  membersPartial: false,
}

const updatedGroup: KeycloakGroupDetailed = {
  ...initialGroup,
  users: ["user-1", "user-2"],
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/settings/groups", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  valkeyStore.clear()
})

describe("GET /api/settings/groups — auth boundary", () => {
  it("401s an unauthenticated session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ error: "unauthorized" })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("403s a non-admin session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ error: "forbidden" })
    const res = await GET()
    expect(res.status).toBe(403)
  })
})

describe("GET /api/settings/groups — caching and invalidation across layers", () => {
  it("populates and returns enriched groups on cache miss", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
    vi.mocked(getGroupsDetailed).mockResolvedValue([initialGroup])
    vi.mocked(getUsers).mockResolvedValue([user1])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toHaveLength(1)
    expect(body[0].members).toEqual([
      { pk: "user-1", username: "alice", email: "alice@example.com" },
    ])
    expect(cacheSet).toHaveBeenCalledWith(
      KEYCLOAK_CACHE_KEYS.groupsEnriched,
      expect.any(Array),
      60
    )
  })

  it("serves from cache when KEYCLOAK_CACHE_KEYS.groupsEnriched is present", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
    const cachedProjection = [{ pk: "cached-grp", name: "Cached Group", members: [] }]
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, cachedProjection)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedProjection)
    expect(getGroupsDetailed).not.toHaveBeenCalled()
    expect(getUsers).not.toHaveBeenCalled()
  })

  it("after addUserToGroup the groups route re-reads instead of serving the stale enriched projection", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })

    // Step 1: Initial state - user-1 in group, cache is cold
    vi.mocked(getGroupsDetailed).mockResolvedValueOnce([initialGroup])
    vi.mocked(getUsers).mockResolvedValueOnce([user1, user2])

    const res1 = await GET()
    expect(res1.status).toBe(200)
    const data1 = await res1.json()
    expect(data1[0].members).toHaveLength(1)
    expect(data1[0].members[0].pk).toBe("user-1")
    expect(getGroupsDetailed).toHaveBeenCalledTimes(1)
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(true)

    // Step 2: Next GET serves from cache without re-fetching
    const res2 = await GET()
    expect(res2.status).toBe(200)
    const data2 = await res2.json()
    expect(data2[0].members).toHaveLength(1)
    expect(getGroupsDetailed).toHaveBeenCalledTimes(1)

    // Step 3: Mutation via addUserToGroup invalidates KEYCLOAK_CACHE_KEYS.groupsEnriched
    vi.mocked(getGroupsDetailed).mockResolvedValueOnce([updatedGroup])
    vi.mocked(getUsers).mockResolvedValueOnce([user1, user2])

    await addUserToGroup("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
    expect(cacheDel).toHaveBeenCalledWith(KEYCLOAK_CACHE_KEYS.groupsEnriched)

    // Step 4: Next GET detects cache miss and re-reads fresh data
    const res3 = await GET()
    expect(res3.status).toBe(200)
    const data3 = await res3.json()
    expect(data3[0].members).toHaveLength(2)
    expect(data3[0].members.map((m: { pk: string }) => m.pk)).toEqual(["user-1", "user-2"])
    expect(getGroupsDetailed).toHaveBeenCalledTimes(2)
  })
})

describe("PATCH /api/settings/groups", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  })

  it("401s an unauthenticated session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ error: "unauthorized" })
    const res = await PATCH(patchReq({ action: "add", groupPk: "grp-1", userPk: "user-1" }))
    expect(res.status).toBe(401)
  })

  it("403s a non-admin session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ error: "forbidden" })
    const res = await PATCH(patchReq({ action: "add", groupPk: "grp-1", userPk: "user-1" }))
    expect(res.status).toBe(403)
  })

  it("400s an invalid action", async () => {
    const res = await PATCH(patchReq({ action: "invalid-action", groupPk: "grp-1" }))
    expect(res.status).toBe(400)
  })

  it("400s when groupPk is missing", async () => {
    const res = await PATCH(patchReq({ action: "add", userPk: "user-1" }))
    expect(res.status).toBe(400)
  })

  it("400s when userPk is missing for add/remove", async () => {
    const resAdd = await PATCH(patchReq({ action: "add", groupPk: "grp-1" }))
    expect(resAdd.status).toBe(400)
    const resRemove = await PATCH(patchReq({ action: "remove", groupPk: "grp-1" }))
    expect(resRemove.status).toBe(400)
  })

  it("400s when attributes is missing for update-attributes", async () => {
    const res = await PATCH(patchReq({ action: "update-attributes", groupPk: "grp-1" }))
    expect(res.status).toBe(400)
  })

  it("executes add action and invalidates groupsEnriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(patchReq({ action: "add", groupPk: "grp-1", userPk: "user-2" }))
    expect(res.status).toBe(200)
    expect(addUserToGroup).toHaveBeenCalledWith("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })

  it("executes remove action and invalidates groupsEnriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(patchReq({ action: "remove", groupPk: "grp-1", userPk: "user-2" }))
    expect(res.status).toBe(200)
    expect(removeUserFromGroup).toHaveBeenCalledWith("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })

  it("executes update-attributes action and invalidates groupsEnriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(
      patchReq({ action: "update-attributes", groupPk: "grp-1", attributes: { env: ["prod"] } })
    )
    expect(res.status).toBe(200)
    expect(updateGroupAttributes).toHaveBeenCalledWith("grp-1", { env: ["prod"] })
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })
})
