import { afterEach, describe, expect, it, vi } from "vitest"
import { listEventsForResync } from "./k8s-event-resync"

afterEach(() => vi.unstubAllGlobals())
const page = (items: unknown[], cursor = "", resourceVersion = "20") => new Response(JSON.stringify({ items, metadata: { resourceVersion, continue: cursor } }))

describe("bounded informer event resync", () => {
  it("collects all pages of one snapshot before returning its watch version", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([{ metadata: { uid: "a" } }], "cursor +/&"))
      .mockResolvedValueOnce(page([{ metadata: { uid: "b" } }]))
    vi.stubGlobal("fetch", fetch)
    expect(await listEventsForResync("https://k8s.test", { Authorization: "Bearer injected" }))
      .toMatchObject({ resourceVersion: "20", items: [{ metadata: { uid: "a" } }, { metadata: { uid: "b" } }] })
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("continue")).toBe("cursor +/&")
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("limit")).toBe("100")
  })
  it("rejects incomplete lists instead of returning a watch version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => page([], "same")))
    await expect(listEventsForResync("https://k8s.test", {})).rejects.toThrow("repeated cursor")
  })
  it("does not combine different snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(page([], "next", "1")).mockResolvedValueOnce(page([], "", "2")))
    await expect(listEventsForResync("https://k8s.test", {})).rejects.toThrow("snapshot changed")
  })
  it("fails visibly when the bounded page budget is exhausted", async () => {
    let count = 0
    const fetch = vi.fn(async () => page([], String(++count)))
    vi.stubGlobal("fetch", fetch)
    await expect(listEventsForResync("https://k8s.test", {})).rejects.toThrow("page limit exceeded")
    expect(fetch).toHaveBeenCalledTimes(100)
  })
  it.each([{}, { items: [], metadata: {} }, { items: new Array(101).fill({}), metadata: { resourceVersion: "1" } }])("rejects malformed/oversized provider pages", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    await expect(listEventsForResync("https://k8s.test", {})).rejects.toThrow("invalid bounded list")
  })
  it("does not retry failed auth or expired continuation responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 410 }))
    vi.stubGlobal("fetch", fetch)
    await expect(listEventsForResync("https://k8s.test", {})).rejects.toThrow("resync events 410")
    expect(fetch).toHaveBeenCalledOnce()
  })
})
