import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Session } from "next-auth"
import type { ArgoApp } from "@/lib/argocd"

vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn(), getActorId: (s: Session) => s.user?.email ?? "unknown" }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return {
    ...actual,
    assertAppAccessible: vi.fn(),
    rollbackArgoApp: vi.fn(),
  }
})
vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getLiveValkey: vi.fn().mockImplementation(() => {
    throw new Error("Valkey unavailable in test environment")
  }),
}))

const { auth } = await import("@/lib/auth")
const { assertAppAccessible, rollbackArgoApp } = await import("@/lib/argocd")
const { POST } = await import("./route")
const { getRecentEvents } = await import("@/lib/live-stream")

const adminSession: Session = {
  user: { email: "admin@example.com", name: "Admin User", role: "cluster-admin" },
  groups: ["cluster-admin"],
  teams: ["ops-team"],
  expires: "2026-12-31T23:59:59Z",
}

const devSession: Session = {
  user: { email: "dev@example.com", name: "Dev User", role: "developer" },
  groups: ["developer"],
  teams: ["app-team"],
  expires: "2026-12-31T23:59:59Z",
}

const mockApp: ArgoApp = {
  metadata: { name: "checkout-api" },
  spec: { project: "ecommerce", destination: { namespace: "storefront" } },
  status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
}

function params(name: string) {
  return { params: Promise.resolve({ name }) }
}

describe("POST /api/catalog/[name]/rollback", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(assertAppAccessible).mockResolvedValue(mockApp)
    vi.mocked(rollbackArgoApp).mockResolvedValue(true)
  })

  it("401s an unauthenticated request", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const req = new Request("http://localhost/api/catalog/checkout-api/rollback", { method: "POST" })
    const res = await POST(req, params("checkout-api"))
    expect(res.status).toBe(401)
  })

  it("403s a non-cluster-admin (developer) caller", async () => {
    vi.mocked(auth).mockResolvedValue(devSession as never)
    const req = new Request("http://localhost/api/catalog/checkout-api/rollback", { method: "POST" })
    const res = await POST(req, params("checkout-api"))
    expect(res.status).toBe(403)
  })

  it("400s when history id is invalid", async () => {
    const req = new Request("http://localhost/api/catalog/checkout-api/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: -1 }),
    })
    const res = await POST(req, params("checkout-api"))
    expect(res.status).toBe(400)
  })

  it("triggers rollback and emits operation.started and operation.completed events", async () => {
    const correlationId = "rollback-corr-789"
    const req = new Request("http://localhost/api/catalog/checkout-api/rollback", {
      method: "POST",
      headers: {
        "x-correlation-id": correlationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 2 }),
    })

    const res = await POST(req, params("checkout-api"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    const events = await getRecentEvents(10)
    const started = events.find((e) => e.correlation_id === correlationId && e.event_type === "operation.started")
    const completed = events.find((e) => e.correlation_id === correlationId && e.event_type === "operation.completed")

    expect(started).toBeDefined()
    expect(completed).toBeDefined()
    expect(started!.resource).toEqual({
      kind: "Application",
      namespace: "storefront",
      name: "checkout-api",
      cluster: "primary",
    })
  })
})
