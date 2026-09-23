import { describe, expect, it, vi, beforeEach } from "vitest"
import type { KeycloakGroupDetailed, KeycloakUser } from "@/lib/keycloak-client"

const valkeyStore = new Map<string, unknown>()

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
}))

vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn(async (key: string) => (valkeyStore.has(key) ? valkeyStore.get(key) : null)),
  cacheSet: vi.fn(async (key: string, val: unknown) => {
    valkeyStore.set(key, val)
  }),
  cacheDel: vi.fn(async (key: string) => {
    valkeyStore.delete(key)
  }),
}))

// Portal #49: keycloak-client is a plain mock here — its mutation functions
// do NOT call the real invalidateKeycloakCaches (that would make this test
// tautological: the route's correctness would depend on keycloak-client's
// internal wiring instead of on the route's own contract with its
// dependencies). Each mutation's default implementation below only deletes
// the enriched key from the same in-memory valkey fake the route reads/
// writes, mirroring the effect a real mutation has. That effect is itself
// verified against the real implementation in keycloak-client.test.ts.
vi.mock("@/lib/keycloak-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/keycloak-client")>()
  return {
    KEYCLOAK_CACHE_KEYS: actual.KEYCLOAK_CACHE_KEYS,
    getGroupsDetailed: vi.fn(),
    getUsers: vi.fn(),
    addUserToGroup: vi.fn(),
    removeUserFromGroup: vi.fn(),
    updateGroupAttributes: vi.fn(),
  }
})

const { requireAdmin } = await import("@/lib/auth")
const {
  getGroupsDetailed,
  getUsers,
  addUserToGroup,
  removeUserFromGroup,
  updateGroupAttributes,
  KEYCLOAK_CACHE_KEYS,
} = await import("@/lib/keycloak-client")
const { cacheSet, cacheDel } = await import("@/lib/valkey")
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

const partialGroup: KeycloakGroupDetailed = {
  ...initialGroup,
  pk: "grp-2",
  name: "Incomplete Group",
  users: [],
  membersPartial: true,
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
  vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  // Default mutation behavior: invalidate the enriched projection, matching
  // what the real keycloak-client mutations do (verified separately in
  // keycloak-client.test.ts).
  vi.mocked(addUserToGroup).mockImplementation(async () => {
    await cacheDel(KEYCLOAK_CACHE_KEYS.groupsEnriched)
  })
  vi.mocked(removeUserFromGroup).mockImplementation(async () => {
    await cacheDel(KEYCLOAK_CACHE_KEYS.groupsEnriched)
  })
  vi.mocked(updateGroupAttributes).mockImplementation(async () => {
    await cacheDel(KEYCLOAK_CACHE_KEYS.groupsEnriched)
  })
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

describe("GET /api/settings/groups — caching", () => {
  it("populates and returns enriched groups on cache miss", async () => {
    vi.mocked(getGroupsDetailed).mockResolvedValue([initialGroup])
    vi.mocked(getUsers).mockResolvedValue([user1])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toHaveLength(1)
    expect(body[0].members).toEqual([{ pk: "user-1", username: "alice", email: "alice@example.com" }])
    expect(cacheSet).toHaveBeenCalledWith(KEYCLOAK_CACHE_KEYS.groupsEnriched, expect.any(Array), 60)
  })

  it("serves from cache when the enriched key is present", async () => {
    const cachedProjection = [{ pk: "cached-grp", name: "Cached Group", members: [] }]
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, cachedProjection)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedProjection)
    expect(getGroupsDetailed).not.toHaveBeenCalled()
    expect(getUsers).not.toHaveBeenCalled()
  })

  it("does not cache a partial getGroupsDetailed result", async () => {
    vi.mocked(getGroupsDetailed).mockResolvedValue([initialGroup, partialGroup])
    vi.mocked(getUsers).mockResolvedValue([user1])

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.some((g: { membersPartial: boolean }) => g.membersPartial)).toBe(true)

    expect(cacheSet).not.toHaveBeenCalled()
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })
})

describe("GET -> PATCH -> GET through the real handlers", () => {
  it("invalidates the enriched projection through PATCH and re-reads fresh data on the next GET", async () => {
    // Step 1: cold cache, initial membership
    vi.mocked(getGroupsDetailed).mockResolvedValueOnce([initialGroup])
    vi.mocked(getUsers).mockResolvedValueOnce([user1, user2])

    const res1 = await GET()
    const data1 = await res1.json()
    expect(data1[0].members).toHaveLength(1)
    expect(getGroupsDetailed).toHaveBeenCalledTimes(1)
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(true)

    // Step 2: next GET is served from cache
    const res2 = await GET()
    const data2 = await res2.json()
    expect(data2[0].members).toHaveLength(1)
    expect(getGroupsDetailed).toHaveBeenCalledTimes(1)

    // Step 3: mutate through the real PATCH handler (not the mutation directly)
    vi.mocked(getGroupsDetailed).mockResolvedValueOnce([updatedGroup])
    vi.mocked(getUsers).mockResolvedValueOnce([user1, user2])

    const patchRes = await PATCH(patchReq({ action: "add", groupPk: "grp-1", userPk: "user-2" }))
    expect(patchRes.status).toBe(200)
    expect(addUserToGroup).toHaveBeenCalledWith("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)

    // Step 4: next GET detects the cache miss and re-reads fresh data
    const res3 = await GET()
    const data3 = await res3.json()
    expect(data3[0].members).toHaveLength(2)
    expect(data3[0].members.map((m: { pk: string }) => m.pk)).toEqual(["user-1", "user-2"])
    expect(getGroupsDetailed).toHaveBeenCalledTimes(2)
  })
})

describe("PATCH /api/settings/groups", () => {
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

  it("executes add action and invalidates the enriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(patchReq({ action: "add", groupPk: "grp-1", userPk: "user-2" }))
    expect(res.status).toBe(200)
    expect(addUserToGroup).toHaveBeenCalledWith("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })

  it("executes remove action and invalidates the enriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(patchReq({ action: "remove", groupPk: "grp-1", userPk: "user-2" }))
    expect(res.status).toBe(200)
    expect(removeUserFromGroup).toHaveBeenCalledWith("grp-1", "user-2")
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })

  it("executes update-attributes action and invalidates the enriched cache", async () => {
    valkeyStore.set(KEYCLOAK_CACHE_KEYS.groupsEnriched, [{ pk: "grp-1" }])
    const res = await PATCH(
      patchReq({ action: "update-attributes", groupPk: "grp-1", attributes: { env: ["prod"] } })
    )
    expect(res.status).toBe(200)
    expect(updateGroupAttributes).toHaveBeenCalledWith("grp-1", { env: ["prod"] })
    expect(valkeyStore.has(KEYCLOAK_CACHE_KEYS.groupsEnriched)).toBe(false)
  })
})
