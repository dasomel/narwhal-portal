import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Session } from "next-auth"

// #47 route-level proof: only fetch + auth + cache are mocked, so the real
// assertAppAccessible / rollbackArgoApp run and the route's status+body mapping is asserted.
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
// operation events are stored and streamed to clients (portal#11), so they are a sink of the raw error too
// real implementation by default; one test injects an untyped error at the rollback step
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, rollbackArgoApp: vi.fn(actual.rollbackArgoApp) }
})
vi.mock("@/lib/live-stream", () => ({ pushEvent: vi.fn().mockResolvedValue(undefined) }))

const FAKE_HOST = "argocd-secret-host.invalid"
const FAKE_TOKEN = "tok-DISTINCTIVE-9f3a1c"

const { requireRole } = await import("@/lib/auth")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { pushEvent } = await import("@/lib/live-stream")
const argocd = await import("@/lib/argocd")
const actualArgo = await vi.importActual<typeof import("@/lib/argocd")>("@/lib/argocd")
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
  status: { sync: { status: "Synced" }, operationState: { phase: "Succeeded" } },
}

const mockFetch = vi.fn()
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status })
// GET app lookup answers 200 app; the rollback POST answers `rollback` (fresh Response per call).
function argo(rollback: () => Response | Promise<Response>) {
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? rollback() : json(app, 200),
  )
}
const posts = () => mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")

async function call() {
  const res = await POST(
    new Request("http://localhost/api/catalog/checkout-api/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 3 }),
    }),
    { params: Promise.resolve({ name: "checkout-api" }) },
  )
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
}

describe("POST /api/catalog/[name]/rollback outcome mapping (#47, fetch-level)", () => {
  beforeEach(() => {
    vi.stubEnv("ARGOCD_URL", `http://${FAKE_HOST}:8080`)
    vi.stubEnv("ARGOCD_TOKEN", FAKE_TOKEN)
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.mocked(invalidateFor).mockClear()
    vi.mocked(pushEvent).mockClear()
    vi.mocked(argocd.rollbackArgoApp).mockImplementation(actualArgo.rollbackArgoApp)
    vi.mocked(requireRole).mockResolvedValue({ session: adminSession } as never)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // [label, rollback answer, expected status, expected outcome]
  const cases: Array<[string, () => Response | Promise<Response>, number, string | undefined]> = [
    ["404 app/revision absent", () => json({ message: `no ${FAKE_HOST}` }, 404), 404, "rejected"],
    ["400 invalid revision", () => json({}, 400), 400, "rejected"],
    ["409 conflicting operation", () => json({}, 409), 409, "rejected"],
    ["401 credential rejected", () => json({}, 401), 503, undefined],
    ["403 forbidden", () => json({}, 403), 403, undefined],
    ["500 server error", () => json({}, 500), 502, "unknown"],
    ["503 unavailable", () => json({}, 503), 502, "unknown"],
    ["timeout", () => Promise.reject(new DOMException(`timed out ${FAKE_HOST}`, "TimeoutError")), 502, "unknown"],
    ["network error", () => Promise.reject(new TypeError(`fetch failed ${FAKE_HOST}`)), 502, "unknown"],
    ["malformed 200 body", () => new Response("<html>not json</html>", { status: 200 }), 502, "unknown"],
    ["200 body that is not an Application", () => json({ ok: true }, 200), 502, "unknown"],
    ["200 Application without spec", () => json({ metadata: { name: "checkout-api" } }, 200), 502, "unknown"],
    ["200 a different Application", () => json({ ...app, metadata: { name: "other-app" } }, 200), 502, "unknown"],
    ["200 array body", () => json([], 200), 502, "unknown"],
    ["200 spec is an array", () => json({ ...app, spec: [] }, 200), 502, "unknown"],
    ["200 metadata is an array", () => json({ ...app, metadata: [] }, 200), 502, "unknown"],
    ["200 null body", () => json(null, 200), 502, "unknown"],
    ["200 empty body", () => new Response("", { status: 200 }), 502, "unknown"],
  ]

  it.each(cases)("%s -> %s", async (_label, rollback, expected, outcome) => {
    argo(rollback)
    const { status, text, body } = await call()
    expect(status).toBe(expected)
    if (outcome) expect(body.outcome).toBe(outcome)
    expect(body.success).not.toBe(true)
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    // the operation event (stored + streamed) must not carry the host/token either
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_HOST)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_TOKEN)
    // a mutation is attempted exactly once -- never auto-retried on timeout/5xx
    expect(posts()).toHaveLength(1)
    expect(invalidateFor).not.toHaveBeenCalled()
  })

  it("unknown outcome does not read as a plain 'Rollback failed'", async () => {
    argo(() => json({}, 500))
    const { body } = await call()
    expect(body.error).not.toBe("Rollback failed")
    expect(String(body.error)).toContain("verify")
  })

  it("accepted rollback keeps the existing success shape", async () => {
    argo(() => json(app, 200))
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(posts()).toHaveLength(1)
  })

  it("a precondition network error does not leak the ArgoCD host or token", async () => {
    mockFetch.mockImplementation(async () => {
      throw new TypeError(`fetch failed http://${FAKE_HOST}:8080 ${FAKE_TOKEN}`)
    })
    const { status, text } = await call()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    expect(posts()).toHaveLength(0)
  })

  it("an untyped rollback-step error is recorded in the operation event with fixed text only", async () => {
    argo(() => json(app, 200))
    // the rollback step throws an untyped error carrying the host + token (e.g. a client-library message)
    vi.mocked(argocd.rollbackArgoApp).mockRejectedValueOnce(
      new Error(`Network error calling http://${FAKE_HOST}:8080/x ${FAKE_TOKEN}`),
    )
    const { text } = await call()
    expect(text).not.toContain(FAKE_HOST)
    const failed = vi.mocked(pushEvent).mock.calls.map(([e]) => e).filter((e) => e.event_type === "operation.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].severity).toBe("error")
    expect(failed[0].operation_id).toBeTruthy()
    expect(failed[0].description).not.toContain(FAKE_HOST)
    expect(failed[0].description).not.toContain(FAKE_TOKEN)
    expect(failed[0].description).not.toContain("Network error")
    expect(failed[0].description).toBe("rollback step failed: ArgoCD request failed")
  })

  it("a precondition network error leaves no host/token in any emitted event", async () => {
    mockFetch.mockImplementation(async () => {
      throw new TypeError(`fetch failed http://${FAKE_HOST}:8080 ${FAKE_TOKEN}`)
    })
    await call()
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_HOST)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_TOKEN)
  })
})
