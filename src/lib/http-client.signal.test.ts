import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchWithPolicy } from "./http-client"

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("RequestInit caller cancellation", () => {
  it("does not send a pre-aborted native caller request", async () => {
    const caller = new AbortController()
    caller.abort()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
    await expect(fetchWithPolicy("https://example.test", { signal: caller.signal }))
      .rejects.toMatchObject({ kind: "aborted" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["init", "options"])("cancels POST when the %s signal aborts with both signals supplied", async (source) => {
    const caller = new AbortController()
    const options = new AbortController()
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("secret failure details")), { once: true })
    })))
    const request = fetchWithPolicy("https://user:secret@example.test/path?token=secret", {
      method: "POST", signal: caller.signal,
    }, { signal: options.signal })
    const assertion = expect(request).rejects.toMatchObject({ kind: "aborted", url: "https://example.test/path" })
    if (source === "init") caller.abort()
    else options.abort()
    await assertion
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("removes fallback caller listeners and keeps the internal timeout active", async () => {
    vi.useFakeTimers()
    const originalAny = AbortSignal.any
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
    const caller = new AbortController()
    const options = new AbortController()
    const callerRemove = vi.spyOn(caller.signal, "removeEventListener")
    const optionsRemove = vi.spyOn(options.signal, "removeEventListener")
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true })
    })))
    try {
      const request = fetchWithPolicy("https://example.test", { signal: caller.signal }, { signal: options.signal, timeoutMs: 10 })
      const assertion = expect(request).rejects.toMatchObject({ kind: "timeout" })
      await vi.advanceTimersByTimeAsync(10)
      await assertion
      expect(callerRemove).toHaveBeenCalledWith("abort", expect.any(Function))
      expect(optionsRemove).toHaveBeenCalledWith("abort", expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      Object.defineProperty(AbortSignal, "any", { configurable: true, value: originalAny })
    }
  })

  it("handles a pre-aborted native signal without AbortSignal.any", async () => {
    const originalAny = AbortSignal.any
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
    const caller = new AbortController()
    caller.abort()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
    try {
      await expect(fetchWithPolicy("https://example.test", { signal: caller.signal }, { signal: new AbortController().signal }))
        .rejects.toMatchObject({ kind: "aborted" })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(AbortSignal, "any", { configurable: true, value: originalAny })
    }
  })

  it.each(["network", "status"])("cancels native caller during %s retry sleep", async (failure) => {
    vi.useFakeTimers()
    const caller = new AbortController()
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new TypeError("network failure")
      return new Response(null, { status: 429, headers: { "retry-after": "5" } })
    }))
    vi.spyOn(Math, "random").mockReturnValue(1)
    const request = fetchWithPolicy("https://example.test", { signal: caller.signal }, {
      retry: { baseDelayMs: 5000, maxDelayMs: 5000 },
    })
    const assertion = expect(request).rejects.toMatchObject({ kind: "aborted" })
    await vi.advanceTimersByTimeAsync(1)
    caller.abort()
    await assertion
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
