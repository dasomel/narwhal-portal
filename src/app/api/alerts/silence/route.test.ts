import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/alertmanager", () => ({ createSilence: vi.fn(), deleteSilence: vi.fn(), getSilence: vi.fn() }))
vi.mock("@/lib/operation-context", () => ({ beginOperation: vi.fn().mockResolvedValue({}), completeOperation: vi.fn(), failOperation: vi.fn() }))
vi.mock("@/lib/scope", () => ({ getEffectiveScope: vi.fn(), }))
vi.mock("@/lib/alert-silence-scope", () => ({ checkSilenceScope: vi.fn(() => ({ ok: true })) }))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireRole } = await import("@/lib/auth")
const { createSilence, deleteSilence } = await import("@/lib/alertmanager")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { POST, DELETE } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin", email: "admin@example.com" } } } as never)
  vi.mocked(createSilence).mockResolvedValue("silence-1")
  vi.mocked(deleteSilence).mockResolvedValue(true)
})

describe("alert silence cache invalidation", () => {
  it("invalidates active alerts after creation", async () => {
    const req = new Request("http://localhost/api/alerts/silence", { method: "POST", body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }) })
    expect((await POST(req)).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("alert.silence.changed", { silenceId: "silence-1" })
  })

  it("does not invalidate after failed create or delete", async () => {
    vi.mocked(createSilence).mockResolvedValue(null as never)
    let req = new Request("http://localhost/api/alerts/silence", { method: "POST", body: JSON.stringify({ alertname: "HighCPU", comment: "maintenance" }) })
    expect((await POST(req)).status).toBe(500)
    expect(invalidateFor).not.toHaveBeenCalled()

    vi.mocked(deleteSilence).mockResolvedValue(false)
    req = new Request("http://localhost/api/alerts/silence?id=silence-1", { method: "DELETE" })
    expect((await DELETE(req)).status).toBe(500)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})
