import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/alertmanager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alertmanager")>()
  return { ...actual, createSilence: vi.fn(), deleteSilence: vi.fn(), getSilence: vi.fn() }
})
vi.mock("@/lib/operation-context", () => ({ beginOperation: vi.fn().mockResolvedValue({}), completeOperation: vi.fn(), failOperation: vi.fn() }))
vi.mock("@/lib/scope", () => ({ getEffectiveScope: vi.fn(), }))
vi.mock("@/lib/alert-silence-scope", () => ({ checkSilenceScope: vi.fn(() => ({ ok: true })) }))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireRole } = await import("@/lib/auth")
const { failOperation } = await import("@/lib/operation-context")
const { createSilence, deleteSilence, AlertmanagerSilenceOutcomeUnknownError } = await import("@/lib/alertmanager")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { POST, DELETE } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin", email: "admin@example.com" } } } as never)
  vi.mocked(createSilence).mockResolvedValue("silence-1")
  vi.mocked(deleteSilence).mockResolvedValue(undefined)
})

describe("alert silence cache invalidation", () => {
  it("invalidates active alerts after creation", async () => {
    const req = new Request("http://localhost/api/alerts/silence", { method: "POST", body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }) })
    expect((await POST(req)).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("alert.silence.changed", { silenceId: "silence-1" })
  })

  it("does not invalidate after failed create or delete", async () => {
    vi.mocked(createSilence).mockRejectedValue(new AlertmanagerSilenceOutcomeUnknownError())
    let req = new Request("http://localhost/api/alerts/silence", { method: "POST", body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }) })
    expect((await POST(req)).status).toBe(502)
    expect(invalidateFor).not.toHaveBeenCalled()

    vi.mocked(deleteSilence).mockRejectedValue(new AlertmanagerSilenceOutcomeUnknownError())
    req = new Request("http://localhost/api/alerts/silence?id=silence-1", { method: "DELETE" })
    expect((await DELETE(req)).status).toBe(502)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})

// Catch-all branch: errors that are not typed Alertmanager errors (lib always wraps, so only a
// mock reaches this). Neither the body nor the failOperation event may echo err.message / a thrown value.
describe("untyped errors never leak into the response or the failure event", () => {
  const FIXED = "Alertmanager silence outcome unknown; change may have been applied, verify before retrying"
  const thrown: Array<[string, unknown]> = [
    ["Error", new Error("boom alertmanager.internal.example tok-SECRET-123")],
    ["non-Error", "boom alertmanager.internal.example tok-SECRET-123"],
  ]

  it.each(thrown)("POST create: %s", async (_label, err) => {
    vi.mocked(createSilence).mockRejectedValue(err)
    const res = await POST(new Request("http://localhost/api/alerts/silence", { method: "POST", body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }) }))
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ success: false, outcome: "unknown", error: FIXED })
    expect(vi.mocked(failOperation).mock.calls[0]?.[2]).toBe(FIXED)
    for (const out of [text, JSON.stringify(vi.mocked(failOperation).mock.calls)]) {
      expect(out).not.toContain("alertmanager.internal.example")
      expect(out).not.toContain("tok-SECRET-123")
    }
  })

  it.each(thrown)("DELETE: %s", async (_label, err) => {
    vi.mocked(deleteSilence).mockRejectedValue(err)
    const res = await DELETE(new Request("http://localhost/api/alerts/silence?id=silence-1", { method: "DELETE" }))
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ success: false, outcome: "unknown", error: FIXED })
    expect(vi.mocked(failOperation).mock.calls[0]?.[2]).toBe(FIXED)
    for (const out of [text, JSON.stringify(vi.mocked(failOperation).mock.calls)]) {
      expect(out).not.toContain("alertmanager.internal.example")
      expect(out).not.toContain("tok-SECRET-123")
    }
  })
})
