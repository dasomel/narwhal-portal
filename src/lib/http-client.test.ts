import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fetchWithPolicy, correlationIdFrom, HttpClientError } from "./http-client"

describe("fetchWithPolicy", () => {
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.useFakeTimers()
    // Full-jitter backoff multiplies by Math.random(); pin it so delays are
    // deterministic (== the exponential base, not a value below it).
    vi.spyOn(Math, "random").mockReturnValue(1)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("aborts the request once the timeout elapses", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    })

    const pending = fetchWithPolicy("http://x/api", {}, { timeoutMs: 1000, retry: false })
    const assertion = expect(pending).rejects.toMatchObject({
      name: "HttpClientError",
      kind: "timeout",
    })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("retries a GET on a retryable status and returns the eventual success", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 3 } })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("does not retry a POST even on a retryable status", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }))

    const res = await fetchWithPolicy("http://x/api", { method: "POST" }, { retry: { maxAttempts: 3 } })

    expect(res.status).toBe(503)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("does not retry a network error beyond maxAttempts, then throws", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 } }
    )
    const assertion = expect(promise).rejects.toMatchObject({ kind: "network" })
    await vi.runAllTimersAsync()
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("honors Retry-After on a 429, capped at maxDelayMs", async () => {
    const headers = new Headers({ "Retry-After": "9999" })
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 429, headers }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { retry: { maxAttempts: 2, maxDelayMs: 500 } }
    )

    // Retry-After (9999s) is capped to maxDelayMs (500ms) — advancing exactly
    // that far must be enough to unblock the retry.
    await vi.advanceTimersByTimeAsync(500)
    const res = await promise

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("propagates an inbound correlation id as X-Correlation-Id", async () => {
    mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }))
    const inbound = new Request("http://caller/route", {
      headers: { "x-correlation-id": "corr-123" },
    })

    await fetchWithPolicy(
      "http://x/api",
      { headers: { "Content-Type": "application/json" } },
      { correlationId: correlationIdFrom(inbound) }
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const sentHeaders = new Headers(init.headers)
    expect(sentHeaders.get("X-Correlation-Id")).toBe("corr-123")
    expect(sentHeaders.get("Content-Type")).toBe("application/json")
  })

  it("omits the correlation header entirely when none is available", async () => {
    mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }))

    await fetchWithPolicy("http://x/api", { headers: { Authorization: "Bearer t" } })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const sentHeaders = new Headers(init.headers)
    expect(sentHeaders.has("X-Correlation-Id")).toBe(false)
    expect(sentHeaders.get("Authorization")).toBe("Bearer t")
  })

  it("never leaks a header value into the thrown error's message", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    let thrown: HttpClientError | null = null
    try {
      await fetchWithPolicy(
        "http://x/api?token=super-secret",
        { headers: { Authorization: "Bearer super-secret-token" } },
        { retry: false }
      )
    } catch (err) {
      thrown = err as HttpClientError
    }

    expect(thrown).toBeInstanceOf(HttpClientError)
    expect(thrown?.message).not.toContain("super-secret")
    expect(thrown?.message).not.toContain("Bearer")
    // Query strings are stripped too — a token passed as a query param (some
    // providers do this) must not survive into the error either.
    expect(thrown?.url).not.toContain("token")
  })
})

describe("correlationIdFrom", () => {
  it("prefers x-correlation-id over x-request-id", () => {
    const headers = new Headers({ "x-correlation-id": "corr-1", "x-request-id": "req-1" })
    expect(correlationIdFrom(headers)).toBe("corr-1")
  })

  it("falls back to x-request-id when no correlation id is present", () => {
    const headers = new Headers({ "x-request-id": "req-1" })
    expect(correlationIdFrom(headers)).toBe("req-1")
  })

  it("returns undefined for a Request with neither header", () => {
    const req = new Request("http://caller/route")
    expect(correlationIdFrom(req)).toBeUndefined()
  })

  it("returns undefined for a null/undefined source", () => {
    expect(correlationIdFrom(null)).toBeUndefined()
    expect(correlationIdFrom(undefined)).toBeUndefined()
  })
})
