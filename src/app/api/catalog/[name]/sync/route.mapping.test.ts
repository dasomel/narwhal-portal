import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Session } from "next-auth"

vi.mock("next-auth", () => ({ default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }) }))
vi.mock("next-auth/providers/credentials", () => ({ default: (opts: unknown) => opts }))
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn(), getActorId: (s: Session) => s.user?.email ?? "unknown" }))
vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getLiveValkey: vi.fn().mockImplementation(() => { throw new Error("Valkey unavailable") }),
}))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/live-stream", () => ({ pushEvent: vi.fn().mockResolvedValue(undefined) }))

const FAKE_HOST = "argocd.internal.example"
const FAKE_TOKEN = "tok-SECRET-123"
const { requireRole } = await import("@/lib/auth")
const { pushEvent } = await import("@/lib/live-stream")
const { POST } = await import("./route")

const adminSession: Session = {
  user: { email: "admin@example.com", name: "Admin", role: "cluster-admin" },
  groups: [],
  teams: [],
  expires: "2026-12-31T23:59:59Z",
}
const app = {
  metadata: { name: "checkout-api" },
  spec: { project: "ecommerce", destination: { namespace: "storefront" } },
  status: { sync: { status: "Synced" } },
}
const mockFetch = vi.fn()

describe("POST /api/catalog/[name]/sync outcome mapping (#47, fetch-level)", () => {
  beforeEach(() => {
    vi.stubEnv("ARGOCD_URL", `http://${FAKE_HOST}:8080`)
    vi.stubEnv("ARGOCD_TOKEN", FAKE_TOKEN)
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.mocked(pushEvent).mockClear()
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("an untyped sync-step error records fixed text only in 502 body and operation event", async () => {
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.reject(new TypeError(`fetch failed http://${FAKE_HOST}:8080 ${FAKE_TOKEN}`))
        : new Response(JSON.stringify(app), { status: 200 })
    )
    const res = await POST(
      new Request("http://localhost/api/catalog/checkout-api/sync", { method: "POST" }),
      { params: Promise.resolve({ name: "checkout-api" }) },
    )
    const text = await res.text()
    const body = JSON.parse(text)
    expect(res.status).toBe(502)
    expect(body.error).toBe("ArgoCD sync failed")
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    const failed = vi.mocked(pushEvent).mock.calls.map(([e]) => e).filter((e) => e.event_type === "operation.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].description).toBe("sync step failed: ArgoCD request failed")
    expect(failed[0].description).not.toContain(FAKE_HOST)
    expect(failed[0].description).not.toContain(FAKE_TOKEN)
  })
})
