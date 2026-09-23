import { describe, expect, it, vi, beforeEach } from "vitest"
import type { KeycloakUser } from "@/lib/keycloak-client"

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  getActorId: vi.fn((s) => s.user.email ?? "unknown"),
}))
vi.mock("@/lib/keycloak-client", () => ({
  getUsers: vi.fn(),
  createUser: vi.fn(),
}))
vi.mock("@/lib/operation-context", () => ({
  beginOperation: vi.fn().mockResolvedValue({}),
  completeOperation: vi.fn().mockResolvedValue(undefined),
  failOperation: vi.fn().mockResolvedValue(undefined),
}))

const { requireAdmin } = await import("@/lib/auth")
const { getUsers, createUser } = await import("@/lib/keycloak-client")
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
})
