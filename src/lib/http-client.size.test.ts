import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_MAX_RESPONSE_BYTES, fetchWithPolicy, readJsonWithPolicy, readTextWithPolicy } from "./http-client"

afterEach(() => vi.unstubAllGlobals())

describe("outbound response byte limits", () => {
  it("rejects oversized chunked bodies without trusting Content-Length and cancels the source", async () => {
    const cancel = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"))
        controller.enqueue(new TextEncoder().encode("456"))
      },
      cancel,
    }), { headers: { "content-length": "1" } })))
    const response = await fetchWithPolicy("https://user:secret@example.test/path?token=secret", {}, { maxResponseBytes: 5 })
    await expect(readTextWithPolicy(response)).rejects.toMatchObject({
      kind: "response-too-large", url: "https://example.test/path",
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it("counts UTF-8 bytes rather than characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("한글")))
    const response = await fetchWithPolicy("https://example.test", {}, { maxResponseBytes: 5 })
    await expect(readTextWithPolicy(response)).rejects.toMatchObject({ kind: "response-too-large" })
  })

  it("accepts JSON exactly at the configured boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"x":1}')))
    const response = await fetchWithPolicy("https://example.test", {}, { maxResponseBytes: 7 })
    await expect(readJsonWithPolicy(response)).resolves.toEqual({ x: 1 })
  })

  it("bounds responses by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES + 1))))
    await expect(readTextWithPolicy(await fetchWithPolicy("https://example.test")))
      .rejects.toMatchObject({ kind: "response-too-large" })
  })

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid size %s before sending a request", async (maxResponseBytes) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(fetchWithPolicy("https://example.test", {}, { maxResponseBytes })).rejects.toThrow(RangeError)
    expect(fetch).not.toHaveBeenCalled()
  })
})
