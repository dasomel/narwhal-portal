import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))

import { cacheGet, cacheSet } from "./valkey"
import { createSilence, getSilence, getSilenceOrThrow, deleteSilence, getAlerts } from "./alertmanager"

// portal#48: these functions now read their response via fetchWithPolicy's
// readJsonWithPolicy, which reads response.body directly (not response.json())
// so a stalled body can be bound to a deadline — a plain `{ ok, json: () => ... }`
// mock has no `.body` ReadableStream and would silently read as empty.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("alertmanager client (portal#48 shared client migration)", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe("createSilence", () => {
    it("returns the new silenceID on success", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ silenceID: "silence-123" }))

      const id = await createSilence([{ name: "alertname", value: "Foo", isRegex: false }], 30, "alice", "maintenance")

      expect(id).toBe("silence-123")
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/silences"),
        expect.objectContaining({ method: "POST" })
      )
    })

    it("returns null (non-throwing) on a connection failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"))

      const id = await createSilence([{ name: "alertname", value: "Foo", isRegex: false }], 30, "alice", "maintenance")

      expect(id).toBeNull()
    })

    // portal#48: POST is a mutation — retry: false explicitly, so a retryable
    // 502/503/504 must not be retried the way a GET would be.
    it("does not retry a retryable 502", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }))

      const id = await createSilence([{ name: "alertname", value: "Foo", isRegex: false }], 30, "alice", "maintenance")

      expect(id).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("getSilence", () => {
    it("returns the parsed silence on success", async () => {
      const silence = {
        id: "silence-123",
        matchers: [],
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2026-01-01T01:00:00Z",
        createdBy: "alice",
        comment: "maintenance",
      }
      mockFetch.mockResolvedValueOnce(jsonResponse(silence))

      const res = await getSilence("silence-123")
      expect(res).toEqual(silence)
    })

    it("returns null (non-throwing) on a connection failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"))
      const res = await getSilence("silence-123")
      expect(res).toBeNull()
    })
  })

  describe("deleteSilence", () => {
    it("returns true on success", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }))
      const ok = await deleteSilence("silence-123")
      expect(ok).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/silence/silence-123"),
        expect.objectContaining({ method: "DELETE" })
      )
    })

    // portal#48: DELETE mutates alertmanager's silence state — retry: false
    // explicitly, even though DELETE is one of the shared client's default
    // idempotent-retry methods.
    it("does not retry a retryable 503", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
      const ok = await deleteSilence("silence-123")
      expect(ok).toBe(false)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe("getAlerts", () => {
    it("returns and caches alerts on success", async () => {
      const alerts = [
        { labels: { alertname: "Foo" }, annotations: {}, status: { state: "active" }, startsAt: "2026-01-01T00:00:00Z" },
      ]
      mockFetch.mockResolvedValueOnce(jsonResponse(alerts))

      const res = await getAlerts()
      expect(res).toEqual(alerts)
      expect(cacheSet).toHaveBeenCalled()
    })

    it("returns [] (non-throwing) on a connection failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"))
      const res = await getAlerts()
      expect(res).toEqual([])
    })

    // #53: getAlertsOrThrow refactor must not change getAlerts' swallow contract.
    it("returns [] (non-throwing) on a persistent HTTP 500", async () => {
      mockFetch.mockImplementation(async () => new Response(null, { status: 500 }))
      const res = await getAlerts()
      expect(res).toEqual([])
    })

    // portal#48: getAlerts kept its pre-existing 5s AbortController timeout,
    // now expressed as fetchWithPolicy's timeoutMs:5000.
    it("aborts once its 5s timeout elapses", async () => {
      vi.useFakeTimers()
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
      })

      const pending = getAlerts()
      await vi.advanceTimersByTimeAsync(5000)
      const res = await pending

      expect(res).toEqual([])
    })
  })

  describe("getSilenceOrThrow body validation (#47)", () => {
    const ok = { id: "sil-1", createdBy: "dev@example.com", matchers: [{ name: "namespace", value: "x", isRegex: false }] }
    const bad: Array<[string, unknown]> = [
      ["matchers [null]", { ...ok, matchers: [null] }],
      ["matchers []", { ...ok, matchers: [] }],
      ["matchers [{}]", { ...ok, matchers: [{}] }],
      ["matchers non-object element", { ...ok, matchers: ["namespace"] }],
      ["matcher name not a string", { ...ok, matchers: [{ name: 1, value: "x" }] }],
      ["matcher value not a string", { ...ok, matchers: [{ name: "n", value: null }] }],
      ["isEqual not a boolean", { ...ok, matchers: [{ name: "n", value: "v", isEqual: "yes" }] }],
      ["id differs from requested", { ...ok, id: "sil-other" }],
      ["createdBy not a string", { ...ok, createdBy: 7 }],
      ["body is an array", []],
      ["body is null", null],
    ]
    it.each(bad)("%s -> AlertmanagerLookupError unavailable", async (_l, body) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(body))
      await expect(getSilenceOrThrow("sil-1")).rejects.toMatchObject({ name: "AlertmanagerLookupError", failure: "unavailable" })
    })
    it("accepts a legitimate expired silence (empty createdBy, isEqual absent, full gettableSilence)", async () => {
      const legit = {
        id: "sil-1", status: { state: "expired" }, updatedAt: "2026-10-15T00:00:00Z", startsAt: "a", endsAt: "b",
        createdBy: "", comment: "",
        matchers: [{ name: "a", value: "b", isRegex: true }, { name: "c", value: "", isRegex: false, isEqual: false }],
      }
      mockFetch.mockResolvedValueOnce(jsonResponse(legit))
      await expect(getSilenceOrThrow("sil-1")).resolves.toMatchObject({ id: "sil-1" })
    })
  })
})
