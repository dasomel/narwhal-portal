import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { Session } from "next-auth"

// #47 route-level proof: only the ArgoCD HTTP layer (fetch) is mocked, so the real
// assertAppAccessible / getArgoAppOrThrow / syncArgoApp run and the status+body
// mapping of the route is what is asserted.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn(), getActorId: (s: Session) => s.user?.email ?? "unknown" }))
vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getLiveValkey: vi.fn().mockImplementation(() => {
    throw new Error("Valkey unavailable in test environment")
  }),
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
  status: {},
}

const mockFetch = vi.fn()
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status })
// GET app lookup answers `lookup`; the sync POST answers `sync` (fresh Response per call).
function argo(lookup: () => Response | Promise<Response>, sync?: () => Response | Promise<Response>) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
    init?.method === "POST" ? sync!() : lookup(),
  )
}

function req() {
  return new NextRequest("http://localhost/api/argocd/sync", {
    method: "POST",
    body: JSON.stringify({ appName: "checkout-api" }),
  })
}

async function call() {
  const res = await POST(req())
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
}

describe("POST /api/argocd/sync status mapping (#47, fetch-level)", () => {
  beforeEach(() => {
    vi.stubEnv("ARGOCD_URL", `http://${FAKE_HOST}:8080`)
    vi.stubEnv("ARGOCD_TOKEN", FAKE_TOKEN)
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.mocked(pushEvent).mockClear()
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const cases: Array<[string, () => void, number, boolean]> = [
    ["ArgoCD 404 on lookup", () => argo(() => json({}, 404)), 404, true],
    ["ArgoCD 401 on lookup", () => argo(() => json({}, 401)), 503, true],
    ["ArgoCD 403 on lookup", () => argo(() => json({}, 403)), 403, true],
    ["ArgoCD 500 on lookup", () => argo(() => json({}, 500)), 502, true],
    ["network error on lookup", () => argo(() => Promise.reject(new TypeError(`fetch failed ${FAKE_HOST}`))), 502, true],
  ]

  it.each(cases)("%s -> %s without leaking host or token", async (_label, setup, expected, hostHidden) => {
    setup()
    const { status, text } = await call()
    expect(status).toBe(expected)
    if (hostHidden) expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    // the write must never be attempted when the precondition lookup failed
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("an untyped sync-step error records fixed text only in 502 body and operation event", async () => {
    argo(
      () => json(app, 200),
      () => Promise.reject(new TypeError(`fetch failed http://${FAKE_HOST}:8080 ${FAKE_TOKEN}`)),
    )
    const { status, text, body } = await call()
    expect(status).toBe(502)
    expect(body.error).toBe("ArgoCD sync failed")
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    const failed = vi.mocked(pushEvent).mock.calls.map(([e]) => e).filter((e) => e.event_type === "operation.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].description).toBe("sync step failed: ArgoCD request failed")
    expect(failed[0].description).not.toContain(FAKE_HOST)
    expect(failed[0].description).not.toContain(FAKE_TOKEN)
  })

  it("an ArgoCD 5xx on the sync POST whose body carries a token never reaches the 502 body or the event", async () => {
    argo(
      () => json(app, 200),
      () => new Response(`upstream blew up http://${FAKE_HOST}:8080 ${FAKE_TOKEN}`, { status: 500 }),
    )
    const { status, text, body } = await call()
    expect(status).toBe(502)
    expect(body.error).toBe("ArgoCD sync failed")
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    const failed = vi.mocked(pushEvent).mock.calls.map(([e]) => e).filter((e) => e.event_type === "operation.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].description).toBe("sync step failed: ArgoCD request failed")
    expect(JSON.stringify(failed[0])).not.toContain(FAKE_TOKEN)
  })

  it("fresh Application (status {}) passes the precondition and reaches the sync POST", async () => {
    argo(
      () => json(app, 200),
      () => json({ metadata: { name: "checkout-api" }, status: { sync: { status: "OutOfSync" } } }, 200),
    )
    const { status } = await call()
    expect(mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true)
    expect(status).toBeLessThan(500)
  })
})
