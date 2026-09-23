import { describe, expect, it, vi, beforeEach } from "vitest"
import type { KeycloakUser } from "@/lib/keycloak-client"

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  getActorId: vi.fn((s) => s.user.email ?? "unknown"),
  ALLOWED_GROUPS: new Set(["cluster-admin", "developer", "viewer", "guest"]),
}))
vi.mock("@/lib/keycloak-client", () => ({
  getUsers: vi.fn(),
  createUser: vi.fn(),
  getGroups: vi.fn(),
  addUserToGroup: vi.fn(),
}))
vi.mock("@/lib/operation-context", () => ({
  beginOperation: vi.fn().mockResolvedValue({}),
  completeOperation: vi.fn().mockResolvedValue(undefined),
  failOperation: vi.fn().mockResolvedValue(undefined),
}))

const { requireAdmin } = await import("@/lib/auth")
const { getUsers, createUser, getGroups, addUserToGroup } = await import("@/lib/keycloak-client")
const { beginOperation, completeOperation, failOperation } = await import("@/lib/operation-context")
const { GET, POST } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }

const newUser: KeycloakUser = {
  pk: "11111111-1111-1111-1111-111111111111",
  username: "jdoe",
  email: "jdoe@example.com",
  name: "Jane Doe",
  is_active: true,
} as KeycloakUser

const validBody = { username: "jdoe", email: "jdoe@example.com", name: "Jane Doe", password: "correct-horse" }

function req(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/settings/users", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createUser).mockResolvedValue(newUser)
  vi.mocked(getGroups).mockResolvedValue([])
  vi.mocked(addUserToGroup).mockResolvedValue(undefined)
})

describe("GET /api/settings/users — auth boundary", () => {
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

  it("200s and does not double-cache (reads straight from getUsers)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
    vi.mocked(getUsers).mockResolvedValue([newUser])
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([newUser])
    expect(getUsers).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/settings/users — auth boundary", () => {
  it("401s an unauthenticated session", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ error: "unauthorized" })
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(401)
    expect(createUser).not.toHaveBeenCalled()
  })
})

describe("POST /api/settings/users — validation", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  })

  it("400s a missing password", async () => {
    const { password: _password, ...rest } = validBody
    const res = await POST(req(rest) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("password")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("400s a short password", async () => {
    const res = await POST(req({ ...validBody, password: "short" }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("password")
  })

  it("400s an invalid email", async () => {
    const res = await POST(req({ ...validBody, email: "not-an-email" }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("email")
  })

  it("400s an invalid username", async () => {
    const res = await POST(req({ ...validBody, username: "a" }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("username")
  })

  it("400s an unsupported group name", async () => {
    const res = await POST(req({ ...validBody, groups: ["super-admin"] }) as never)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("ValidationError")
    expect(json.field).toBe("groups")
    expect(json.message).toContain("unsupported group")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("400s non-array groups", async () => {
    const res = await POST(req({ ...validBody, groups: "developer" }) as never)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("ValidationError")
    expect(json.field).toBe("groups")
    expect(json.message).toContain("array of strings")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("400s non-string items in groups array", async () => {
    const res = await POST(req({ ...validBody, groups: [123] }) as never)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("ValidationError")
    expect(json.field).toBe("groups")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("400s duplicate groups", async () => {
    const res = await POST(req({ ...validBody, groups: ["developer", "developer"] }) as never)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("ValidationError")
    expect(json.field).toBe("groups")
    expect(json.message).toContain("duplicate group")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("400s when groups count exceeds supported roles count", async () => {
    const res = await POST(
      req({ ...validBody, groups: ["cluster-admin", "developer", "viewer", "guest", "extra"] }) as never,
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("ValidationError")
    expect(json.field).toBe("groups")
    expect(createUser).not.toHaveBeenCalled()
  })

  it("does not pass unknown/smuggled fields through to createUser", async () => {
    await POST(req({ ...validBody, role: "cluster-admin", isSuperuser: true }) as never)
    expect(createUser).toHaveBeenCalledWith({
      username: validBody.username,
      email: validBody.email,
      name: validBody.name,
      password: validBody.password,
    })
  })
})

describe("POST /api/settings/users — role groups handling", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  })

  it("resolves groups and adds user to groups on success", async () => {
    vi.mocked(getGroups).mockResolvedValue([
      { pk: "gid-dev", name: "developer", num_pk: 0 },
      { pk: "gid-viewer", name: "viewer", num_pk: 0 },
    ])
    const res = await POST(req({ ...validBody, groups: ["developer", "viewer"] }) as never)
    expect(res.status).toBe(201)
    expect(createUser).toHaveBeenCalledWith({
      username: validBody.username,
      email: validBody.email,
      name: validBody.name,
      password: validBody.password,
    })
    expect(getGroups).toHaveBeenCalledTimes(1)
    expect(addUserToGroup).toHaveBeenCalledWith("gid-dev", newUser.pk)
    expect(addUserToGroup).toHaveBeenCalledWith("gid-viewer", newUser.pk)
    expect(completeOperation).toHaveBeenCalledWith(
      expect.anything(),
      `User created: ${validBody.username}`,
      expect.stringContaining("groups=developer,viewer"),
    )
  })

  it("creates bare user when no groups are provided (unchanged behavior)", async () => {
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(201)
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(getGroups).not.toHaveBeenCalled()
    expect(addUserToGroup).not.toHaveBeenCalled()
    expect(completeOperation).toHaveBeenCalledWith(
      expect.anything(),
      `User created: ${validBody.username}`,
      `id=${newUser.pk}; email=${validBody.email}`,
    )
  })

  it("creates bare user when empty groups array is provided", async () => {
    const res = await POST(req({ ...validBody, groups: [] }) as never)
    expect(res.status).toBe(201)
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(getGroups).not.toHaveBeenCalled()
    expect(addUserToGroup).not.toHaveBeenCalled()
  })

  it("fails with partial-state message and calls failOperation when a group is missing in Keycloak", async () => {
    vi.mocked(getGroups).mockResolvedValue([
      { pk: "gid-dev", name: "developer", num_pk: 0 },
      // "viewer" is missing
    ])
    const res = await POST(req({ ...validBody, groups: ["developer", "viewer"] }) as never)
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe("PartialStateError")
    expect(json.message).toContain(`User created (id=${newUser.pk})`)
    expect(json.message).toContain("viewer")
    expect(failOperation).toHaveBeenCalledWith(
      expect.anything(),
      `User created with partial state: ${validBody.username}`,
      expect.stringContaining(`User created (id=${newUser.pk})`),
    )
    expect(completeOperation).not.toHaveBeenCalled()
  })

  it("fails with partial-state message when addUserToGroup throws", async () => {
    vi.mocked(getGroups).mockResolvedValue([
      { pk: "gid-dev", name: "developer", num_pk: 0 },
    ])
    vi.mocked(addUserToGroup).mockRejectedValue(new Error("Keycloak network error"))
    const res = await POST(req({ ...validBody, groups: ["developer"] }) as never)
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).toBe("PartialStateError")
    expect(json.message).toContain(`User created (id=${newUser.pk})`)
    // upstream error text goes to the operation record, never the response body
    expect(json.message).not.toContain("Keycloak network error")
    expect(failOperation).toHaveBeenCalledWith(
      expect.anything(),
      `User created with partial state: ${validBody.username}`,
      expect.stringContaining("Keycloak network error"),
    )
    expect(completeOperation).not.toHaveBeenCalled()
  })
})

describe("POST /api/settings/users — audit/event emission", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  })

  it("emits operation.started/completed on success", async () => {
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(201)
    expect(beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationType: "identity.user.create" }),
    )
    expect(completeOperation).toHaveBeenCalled()
    expect(failOperation).not.toHaveBeenCalled()
  })

  it("emits operation.failed and 500s when createUser throws", async () => {
    vi.mocked(createUser).mockRejectedValue(new Error("Keycloak unavailable"))
    const res = await POST(req(validBody) as never)
    expect(res.status).toBe(500)
    expect(failOperation).toHaveBeenCalled()
  })
})

describe("POST /api/settings/users — idempotency", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockResolvedValue({ session: adminSession as never })
  })

  it("does not create a second user for a repeated Idempotency-Key", async () => {
    const first = await POST(req(validBody, { "Idempotency-Key": "retry-1" }) as never)
    expect(first.status).toBe(201)
    expect(createUser).toHaveBeenCalledTimes(1)

    const second = await POST(req(validBody, { "Idempotency-Key": "retry-1" }) as never)
    expect(second.status).toBe(201)
    expect((await second.json()).duplicate).toBe(true)
    expect(createUser).toHaveBeenCalledTimes(1)
  })

  it("rejects request when Idempotency-Key is reused with different groups", async () => {
    vi.mocked(getGroups).mockResolvedValue([
      { pk: "gid-dev", name: "developer", num_pk: 0 },
      { pk: "gid-viewer", name: "viewer", num_pk: 0 },
    ])
    const first = await POST(
      req({ ...validBody, groups: ["developer"] }, { "Idempotency-Key": "retry-diff-groups" }) as never,
    )
    expect(first.status).toBe(201)

    const second = await POST(
      req({ ...validBody, groups: ["viewer"] }, { "Idempotency-Key": "retry-diff-groups" }) as never,
    )
    expect(second.status).toBe(400)
    const json = await second.json()
    expect(json.field).toBe("Idempotency-Key")
    expect(json.message).toBe("Idempotency-Key reused with a different request body")
  })
})
