import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ rows: [] as string[], fail: true, incrFail: false, subscribeFail: false, counter: BigInt(0), listeners: [] as ((channel: string, message: string) => void)[], unsubscribes: 0, disconnects: 0, removals: 0 }))
vi.mock("./valkey", () => ({
  getLiveValkey: () => {
    if (state.fail) throw new Error("offline")
    const client = {
      set: async (key: string, value: string, mode: string) => { void key; void mode; if (state.counter === BigInt(0)) state.counter = BigInt(value); return "OK" },
      incr: async (key: string) => { void key; if (state.incrFail) throw new Error("incr failed"); state.counter += BigInt(1); return state.counter.toString() },
      pipeline: () => {
        const value: { payload?: string } = {}
        const pipe = { lpush: (_k: string, p: string) => { value.payload = p; return pipe }, ltrim: () => pipe,
          publish: (_k: string, p: string) => { value.payload = p; return pipe }, exec: async () => { if (value.payload) state.rows.unshift(value.payload); return [] } }
        return pipe
      },
      lrange: async (_k: string, start: number, end: number) => state.rows.slice(start, end + 1),
      duplicate: () => ({ on: (_name: string, listener: (channel: string, message: string) => void) => { state.listeners.push(listener) },
        removeListener: (_name: string, listener: (channel: string, message: string) => void) => { state.listeners = state.listeners.filter((item) => item !== listener); state.removals++ },
        subscribe: async () => { if (state.subscribeFail) throw new Error("subscribe failed") }, unsubscribe: async () => { state.unsubscribes++ }, disconnect: () => { state.disconnects++ } }),
    }
    return client
  },
}))

const { pushEvent, getRecentEvents, replayAfter, getLiveStreamStatus, subscribeLiveWithReplay, compareLiveEventIds } = await import("./live-stream")

async function add(title: string) {
  return pushEvent({ type: "custom", severity: "info", title, description: title, source: "manual" })
}

describe("live stream replay", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-28T00:00:00Z")); state.rows = []; state.fail = true; state.incrFail = false; state.subscribeFail = false; state.counter = BigInt(0); state.listeners = []; state.unsubscribes = 0; state.disconnects = 0; state.removals = 0 })
  it("replays strictly after an in-window cursor in order", async () => {
    state.fail = false
    const a = await add("a"), b = await add("b"), c = await add("c")
    const result = await replayAfter(a.id)
    expect(result.events.map((e) => e.title)).toEqual(["b", "c"])
    expect(new Set(result.events.map((e) => e.id)).size).toBe(2)
    expect(compareLiveEventIds(b.id, c.id)).toBe(-1)
  })
  it("signals a cursor older than retention", async () => {
    const first = await add("first")
    for (let i = 0; i < 1000; i++) await add(`event-${i}`)
    expect(await replayAfter(first.id)).toMatchObject({ events: [], gap: false, unknown: true })
  })
  it("marks malformed cursors unknown", async () => {
    await add("event")
    expect(await replayAfter("not-an-id")).toMatchObject({ events: [], gap: false, unknown: true })
  })
  it("reports degraded in-memory status and keeps a local replay ring", async () => {
    const event = await add("local")
    expect(getLiveStreamStatus()).toMatchObject({ dependency: "valkey", state: "partial" })
    expect((await getRecentEvents(1))[0]?.id).toBe(event.id)
  })

  it("uses a shared Valkey counter for monotonically ordered publisher IDs", async () => {
    state.fail = false
    const a = await add("publisher-a"), b = await add("publisher-b")
    expect(a.id).not.toBe(b.id)
    expect(a.id).toBe("1")
    expect(b.id).toBe("2")
    expect(compareLiveEventIds("10", "9")).toBe(1)
  })

  it("persists and publishes with a degraded ID when INCR fails", async () => {
    state.fail = false
    state.incrFail = true
    const event = await add("incr fallback")
    expect(event.id).toMatch(/^d-\d+-\d+$/)
    expect(JSON.parse(state.rows[0]!).id).toBe(event.id)
  })

  it("replays degraded cursors only on an exact local-ring match", async () => {
    const first = await add("degraded first")
    await add("degraded next")
    expect((await replayAfter(first.id)).events.map((event) => event.title)).toEqual(["degraded next"])
    expect(await replayAfter("d-1-999")).toMatchObject({ events: [], gap: false, unknown: true })
    expect(await replayAfter("1720000000000-000001")).toMatchObject({ events: [], gap: false, unknown: true })
  })

  it("keeps shared counter ordering independent of degraded IDs", async () => {
    state.fail = false
    const earlier = await add("shared before")
    state.incrFail = true
    const degraded = await add("degraded blip")
    state.incrFail = false
    const later = await add("shared after")
    expect(compareLiveEventIds(later.id, earlier.id)).toBe(1)
    expect(compareLiveEventIds(later.id, degraded.id)).toBeNull()
  })

  it("marks degraded when pub/sub subscribe fails", async () => {
    state.fail = false
    state.subscribeFail = true
    const controller = new AbortController()
    const setup = await subscribeLiveWithReplay(undefined, controller.signal)
    const iterator = setup.live[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow("subscribe failed")
    expect(getLiveStreamStatus()).toMatchObject({ dependency: "valkey", state: "partial", reason: "subscription_failure" })
  })

  it("aborting with no pending event cleans up the subscription and abort listener", async () => {
    state.fail = false
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, "addEventListener")
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
    const setup = await subscribeLiveWithReplay(undefined, controller.signal)
    const iterator = setup.live[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    expect(state.listeners).toHaveLength(1)

    controller.abort()
    expect(await pending).toMatchObject({ done: true })
    expect(state.unsubscribes).toBe(1)
    expect(state.disconnects).toBe(1)
    expect(state.removals).toBe(1)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(state.listeners).toHaveLength(0)
  })
})
