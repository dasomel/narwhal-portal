import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(), requireRole: vi.fn() }))

const { auth, requireRole } = await import("@/lib/auth")
const { POST } = await import("./route")

const session = {
  teams: ["platform-team"],
  user: { role: "developer" },
}
const allowed = { session }

function request(body: string) {
  return new Request("http://localhost/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(auth).mockResolvedValue(session as never)
  vi.mocked(requireRole).mockResolvedValue(allowed as never)
})

describe("POST /api/templates", () => {
  it("preserves the unauthenticated and forbidden role gate responses", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const unauthorized = await POST(request("{}"))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: "Unauthorized" })

    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" } as never)
    const forbidden = await POST(request("{}"))
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: "Forbidden" })
  })

  it("returns the validator status and error code for invalid input", async () => {
    const res = await POST(request(JSON.stringify({ templateId: "missing", values: {} })))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: { code: "UNKNOWN_TEMPLATE", message: "Template does not exist" },
    })
  })

  it("keeps the existing preview response for the UI request shape", async () => {
    const values = { serviceName: "orders", namespace: "dev-orders", replicas: "2" }
    const res = await POST(request(JSON.stringify({ templateId: "nextjs-web", values })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      preview: {
        templateId: "nextjs-web",
        values,
        willCreate: [
          "Gitea repository: orders",
          "ArgoCD application: orders",
          "Namespace: dev-orders",
        ],
      },
    })
  })
})
