import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Session } from "next-auth"

// #47 route-level proof for the silence DELETE write precondition: only fetch + auth are
// mocked, so the real getSilenceOrThrow / deleteSilence run and the route's status+body
// mapping is what is asserted.
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

const FAKE_HOST = "alertmanager-secret-host.invalid"

const { requireRole } = await import("@/lib/auth")
const { DELETE } = await import("./route")

const developer: Session = {
  user: { email: "dev@example.com", name: "Dev", role: "developer" },
  groups: [],
  teams: [],
  expires: "2026-12-31T23:59:59Z",
}

const silence = (createdBy: string) => ({
  id: "sil-1",
  matchers: [{ name: "namespace", value: "storefront", isRegex: false }],
  createdBy,
  comment: "c",
  startsAt: "2026-10-15T00:00:00Z",
  endsAt: "2026-10-15T01:00:00Z",
})

const mockFetch = vi.fn()
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status })
const isDelete = ([, init]: unknown[]) => (init as RequestInit | undefined)?.method === "DELETE"
// GET lookup answers `lookup`; the DELETE answers 200 (fresh Response per call).
function alertmanager(lookup: () => Response | Promise<Response>) {
  mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "DELETE" ? new Response("", { status: 200 }) : lookup(),
  )
}

async function call() {
  const res = await DELETE(new Request("http://localhost/api/alerts/silence?id=sil-1", { method: "DELETE" }))
  return { status: res.status, text: await res.text() }
}

describe("DELETE /api/alerts/silence ownership lookup mapping (#47, fetch-level)", () => {
  beforeEach(() => {
    vi.stubEnv("ALERTMANAGER_URL", `http://${FAKE_HOST}:9093`)
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.mocked(requireRole).mockResolvedValue({ session: developer } as never)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const cases: Array<[string, () => void, number]> = [
    ["Alertmanager 404 on lookup", () => alertmanager(() => json({}, 404)), 404],
    ["Alertmanager 401 on lookup", () => alertmanager(() => json({}, 401)), 503],
    ["Alertmanager 403 on lookup", () => alertmanager(() => json({}, 403)), 403],
    ["Alertmanager 500 on lookup", () => alertmanager(() => json({}, 500)), 502],
    ["network error on lookup", () => alertmanager(() => Promise.reject(new TypeError(`fetch failed ${FAKE_HOST}`))), 502],
    ["malformed 200 body on lookup", () => alertmanager(() => json({ unexpected: true }, 200)), 502],
    ["non-JSON 200 body on lookup", () => alertmanager(() => new Response("<html>", { status: 200 })), 502],
  ]

  it.each(cases)("%s -> %s, no host leak, no DELETE sent", async (_label, setup, expected) => {
    setup()
    const { status, text } = await call()
    expect(status).toBe(expected)
    expect(text).not.toContain(FAKE_HOST)
    expect(mockFetch.mock.calls.some(isDelete)).toBe(false)
  })

  it("non-owner is still 403 and sends no DELETE", async () => {
    alertmanager(() => json(silence("someone-else@example.com"), 200))
    const { status } = await call()
    expect(status).toBe(403)
    expect(mockFetch.mock.calls.some(isDelete)).toBe(false)
  })

  it("owner passes the precondition and reaches the DELETE", async () => {
    alertmanager(() => json(silence("dev@example.com"), 200))
    const { status } = await call()
    expect(status).toBe(200)
    expect(mockFetch.mock.calls.some(isDelete)).toBe(true)
  })
})
