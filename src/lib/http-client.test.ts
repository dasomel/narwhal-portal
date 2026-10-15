import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fetchWithPolicy, correlationIdFrom, readJsonWithPolicy, HttpClientError } from "./http-client"

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

  it("still strips userinfo from the error when the URL is one new URL() rejects", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))
    // Unescaped space makes this reject the WHATWG URL parser, exercising the
    // regex fallback branch of redactUrl rather than the `new URL()` happy path.
    const malformed = "http://user:s3cr3t@host with space/path"

    let thrown: HttpClientError | null = null
    try {
      await fetchWithPolicy(malformed, {}, { retry: false })
    } catch (err) {
      thrown = err as HttpClientError
    }

    expect(thrown).toBeInstanceOf(HttpClientError)
    expect(thrown?.url).not.toContain("s3cr3t")
    expect(thrown?.message).not.toContain("s3cr3t")
    expect(thrown?.url).toBe("http://host with space/path")
  })

  it.each(["network", "status"])("cancels %s retry backoff immediately without another request", async (failure) => {
    const caller = new AbortController()
    if (failure === "network") mockFetch.mockRejectedValue(new TypeError("fetch failed"))
    else mockFetch.mockImplementation(async () => new Response(null, { status: 503 }))
    const request = fetchWithPolicy("https://user:secret@example.test/api?token=secret", {}, {
      signal: caller.signal, retry: { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 5000 },
    })
    const assertion = expect(request).rejects.toMatchObject({ kind: "aborted", url: "https://example.test/api" })
    await vi.advanceTimersByTimeAsync(1)
    caller.abort()
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("honors a caller-supplied abort signal: classified 'aborted', never retried", async () => {
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
    )
    const caller = new AbortController()

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { timeoutMs: 5000, signal: caller.signal, retry: { maxAttempts: 3 } }
    )
    const assertion = expect(promise).rejects.toMatchObject({
      name: "HttpClientError",
      kind: "aborted",
    })
    caller.abort()
    await assertion

    // GET + retry enabled would normally retry a failure — but a caller abort
    // must never trigger one.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still classifies as 'timeout' (not 'aborted') when only the internal timer fires and no caller signal was ever aborted", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        })
      })
    })
    const caller = new AbortController()

    const promise = fetchWithPolicy(
      "http://x/api",
      {},
      { timeoutMs: 1000, signal: caller.signal, retry: false }
    )
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it("drains a retried response's body so the connection is released", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stale"))
      },
    })
    const cancelSpy = vi.spyOn(stream, "cancel")
    mockFetch
      .mockResolvedValueOnce(new Response(stream, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 2 } })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it("does not attempt to cancel an already-consumed retried body", async () => {
    const emptyRes = new Response(null, { status: 503 })
    expect(emptyRes.body).toBeNull()
    mockFetch
      .mockResolvedValueOnce(emptyRes)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 2 } })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
  })

  it("bounds a body read by the remaining deadline and cancels a stalled body", async () => {
    // Reading via readJsonWithPolicy acquires its own reader (see
    // collectBytesWithDeadline), which locks the stream — a locked stream's
    // own .cancel() method throws, so cancellation on timeout goes through
    // that reader instead. Assert on the underlying cancel ALGORITHM (the
    // `cancel` option below), which fires either way, rather than spying on
    // the (here, unreachable-once-locked) public stream.cancel method.
    const cancelUnderlying = vi.fn()
    const stream = new ReadableStream({
      start() {
        /* never enqueue or close — simulates a stalled upstream body */
      },
      cancel(reason) {
        cancelUnderlying(reason)
      },
    })
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }))

    const res = await fetchWithPolicy("http://x/api", { method: "GET" }, { timeoutMs: 1000 })
    const pending = readJsonWithPolicy(res)
    const assertion = expect(pending).rejects.toMatchObject({
      name: "HttpClientError",
      kind: "timeout",
    })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(cancelUnderlying).toHaveBeenCalledTimes(1)
  })

  it("reads a fast body normally within the deadline", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const res = await fetchWithPolicy("http://x/api", { method: "GET" }, { timeoutMs: 1000 })
    const data = await readJsonWithPolicy<{ ok: boolean }>(res)

    expect(data.ok).toBe(true)
    expect(res.body?.locked).toBe(false)
  })

  it("falls back to a plain, unbounded read for a Response this client never produced", async () => {
    const handCrafted = new Response(JSON.stringify({ ok: true }))
    const data = await readJsonWithPolicy<{ ok: boolean }>(handCrafted)
    expect(data.ok).toBe(true)
  })

  it("clears its timer after a normal successful call (no leaked timer)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("ok", { status: 200 }))
    const caller = new AbortController()

    await fetchWithPolicy("http://x/api", {}, { signal: caller.signal })

    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears its timer after exhausting retries on a network error (no leaked timer)", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 } }
    )
    const assertion = expect(promise).rejects.toMatchObject({ kind: "network" })
    await vi.runAllTimersAsync()
    await assertion

    expect(vi.getTimerCount()).toBe(0)
  })

  it("retries on a connection reset error (ECONNRESET) and succeeds on subsequent attempt", async () => {
    const resetErr = Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" })
    mockFetch
      .mockRejectedValueOnce(resetErr)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 2 } })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("normalizes a connection reset error (ECONNRESET) to kind 'network' on retry exhaustion", async () => {
    const resetErr = Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" })
    mockFetch.mockRejectedValue(resetErr)

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 } }
    )
    const assertion = expect(promise).rejects.toMatchObject({
      name: "HttpClientError",
      kind: "network",
      cause: resetErr,
    })
    await vi.runAllTimersAsync()
    await assertion
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("does not retry a 401 Unauthorized response and returns it immediately", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))

    const res = await fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 3 } })

    expect(res.status).toBe(401)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("does not retry a 403 Forbidden response and returns it immediately", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }))

    const res = await fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 3 } })

    expect(res.status).toBe(403)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("does not retry a 500 Internal Server Error even on an idempotent GET", async () => {
    mockFetch.mockResolvedValueOnce(new Response("server error", { status: 500 }))

    const res = await fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 3 } })

    expect(res.status).toBe(500)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("retries a GET on 502 Bad Gateway and 504 Gateway Timeout statuses", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 504 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    const promise = fetchWithPolicy("http://x/api", { method: "GET" }, { retry: { maxAttempts: 3 } })
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("returns the final retryable status response after exhausting maxAttempts", async () => {
    mockFetch.mockResolvedValue(new Response("unavailable", { status: 503 }))

    const promise = fetchWithPolicy(
      "http://x/api",
      { method: "GET" },
      { retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 } }
    )
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(503)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it("does not retry a non-idempotent mutation (POST) on network error and throws kind 'network'", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    const promise = fetchWithPolicy("http://x/api", { method: "POST" }, { retry: { maxAttempts: 3 } })
    const assertion = expect(promise).rejects.toMatchObject({
      name: "HttpClientError",
      kind: "network",
    })
    await assertion

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("does not retry a non-idempotent mutation (PATCH) even on a retryable status", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }))

    const res = await fetchWithPolicy("http://x/api", { method: "PATCH" }, { retry: { maxAttempts: 3 } })

    expect(res.status).toBe(503)
    expect(mockFetch).toHaveBeenCalledTimes(1)
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
