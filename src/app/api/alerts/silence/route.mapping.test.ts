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
vi.mock("@/lib/live-stream", () => ({ pushEvent: vi.fn().mockResolvedValue(undefined) }))

const FAKE_HOST = "alertmanager.internal.example"
const FAKE_TOKEN = "tok-SECRET-123"

const { requireRole } = await import("@/lib/auth")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { pushEvent } = await import("@/lib/live-stream")
const { DELETE, POST } = await import("./route")

const developer: Session = {
  user: { email: "dev@example.com", name: "Dev", role: "developer" },
  groups: [],
  teams: [],
  expires: "2026-12-31T23:59:59Z",
}

const admin: Session = {
  user: { email: "admin@example.com", name: "Admin", role: "cluster-admin" },
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

  const m = (over: object) => ({ ...silence("dev@example.com"), ...over })
  const badBodies: Array<[string, unknown]> = [
    ["matchers [null]", m({ matchers: [null] })],
    ["matchers []", m({ matchers: [] })],
    ["matchers [{}]", m({ matchers: [{}] })],
    ["matchers non-object element", m({ matchers: ["namespace"] })],
    ["matcher name not a string", m({ matchers: [{ name: 1, value: "x" }] })],
    ["matcher value not a string", m({ matchers: [{ name: "namespace", value: null }] })],
    ["response id differs from requested id", m({ id: "sil-other" })],
    ["body is an array", []],
  ]
  it.each(badBodies)("owner + %s -> 502, no DELETE sent (#47 fail closed)", async (_label, body) => {
    alertmanager(() => json(body, 200))
    const { status, text } = await call()
    expect(status).toBe(502)
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

describe("POST and DELETE /api/alerts/silence write outcome mapping (#47, fetch-level)", () => {
  beforeEach(() => {
    vi.stubEnv("ALERTMANAGER_URL", `http://${FAKE_HOST}:9093`)
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.mocked(requireRole).mockResolvedValue({ session: admin } as never)
    vi.mocked(invalidateFor).mockClear()
    vi.mocked(pushEvent).mockClear()
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function callPost() {
    const res = await POST(
      new Request("http://localhost/api/alerts/silence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }),
      }),
    )
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
  }

  async function callDelete() {
    const res = await DELETE(new Request("http://localhost/api/alerts/silence?id=sil-1", { method: "DELETE" }))
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> }
  }

  const postCases: Array<[string, () => Response | Promise<Response>, number, string | undefined]> = [
    ["400 bad request", () => json({ error: `no ${FAKE_HOST}` }, 400), 400, "rejected"],
    ["422 unprocessable", () => json({ error: `no ${FAKE_HOST}` }, 422), 422, "rejected"],
    ["401 credential rejected", () => json({}, 401), 503, undefined],
    ["403 forbidden", () => json({}, 403), 403, undefined],
    ["500 server error", () => json({}, 500), 502, "unknown"],
    ["timeout", () => Promise.reject(new DOMException(`timed out ${FAKE_HOST}`, "TimeoutError")), 502, "unknown"],
    ["network error", () => Promise.reject(new TypeError(`fetch failed http://${FAKE_HOST}:9093 ${FAKE_TOKEN}`)), 502, "unknown"],
    ["malformed 2xx without id", () => json({}, 200), 502, "unknown"],
    ["malformed 2xx array body", () => json([{ silenceID: "x" }], 200), 502, "unknown"],
    ["malformed 2xx non-string id", () => json({ silenceID: 7 }, 200), 502, "unknown"],
  ]

  const deleteCases: Array<[string, () => Response | Promise<Response>, number, string | undefined]> = [
    ["404 silence absent", () => json({ message: `no ${FAKE_HOST}` }, 404), 404, undefined],
    ["400 bad request", () => json({ error: `no ${FAKE_HOST}` }, 400), 400, "rejected"],
    ["422 unprocessable", () => json({ error: `no ${FAKE_HOST}` }, 422), 422, "rejected"],
    ["401 credential rejected", () => json({}, 401), 503, undefined],
    ["403 forbidden", () => json({}, 403), 403, undefined],
    ["500 server error", () => json({}, 500), 502, "unknown"],
    ["timeout", () => Promise.reject(new DOMException(`timed out ${FAKE_HOST}`, "TimeoutError")), 502, "unknown"],
    ["network error", () => Promise.reject(new TypeError(`fetch failed http://${FAKE_HOST}:9093 ${FAKE_TOKEN}`)), 502, "unknown"],
  ]

  it.each(postCases)("POST write: %s", async (_label, handler, expected, outcome) => {
    mockFetch.mockImplementation(async () => handler())
    const { status, text, body } = await callPost()
    expect(status).toBe(expected)
    if (outcome) expect(body.outcome).toBe(outcome)
    if (outcome === "unknown") {
      expect(body.error).toContain("may have been applied")
      expect(body.error).toContain("verify before retrying")
    }
    expect(body.success).not.toBe(true)
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_HOST)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_TOKEN)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(invalidateFor).not.toHaveBeenCalled()
  })

  it.each(deleteCases)("DELETE write: %s", async (_label, handler, expected, outcome) => {
    mockFetch.mockImplementation(async () => handler())
    const { status, text, body } = await callDelete()
    expect(status).toBe(expected)
    if (outcome) expect(body.outcome).toBe(outcome)
    if (outcome === "unknown") {
      expect(body.error).toContain("may have been applied")
      expect(body.error).toContain("verify before retrying")
    }
    if (_label.includes("404")) expect(body.error).toBe("Silence not found / already expired")
    expect(body.success).not.toBe(true)
    expect(text).not.toContain(FAKE_HOST)
    expect(text).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_HOST)
    expect(JSON.stringify(vi.mocked(pushEvent).mock.calls)).not.toContain(FAKE_TOKEN)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(invalidateFor).not.toHaveBeenCalled()
  })

  it("POST write accepted returns existing success shape", async () => {
    mockFetch.mockImplementation(async () => json({ silenceID: "sil-new-1" }, 200))
    const { status, body } = await callPost()
    expect(status).toBe(200)
    expect(body).toEqual({ success: true, silenceId: "sil-new-1" })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(invalidateFor).toHaveBeenCalledWith("alert.silence.changed", { silenceId: "sil-new-1" })
  })

  it("DELETE write accepted returns existing success shape", async () => {
    mockFetch.mockImplementation(async () => new Response("", { status: 200 }))
    const { status, body } = await callDelete()
    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(invalidateFor).toHaveBeenCalledWith("alert.silence.changed", { silenceId: "sil-1" })
  })
})

