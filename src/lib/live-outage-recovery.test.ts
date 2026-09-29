import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LiveEvent } from "@/types/live"

/**
 * portal#13 — outage/recovery durability proof.
 *
 * Drives the REAL ingest/replay code paths (live-k8s-informer's watch loop,
 * live-stream's pushEvent/replayAfter, idempotency's claim/fulfill) through a
 * combined Valkey persistence outage and a K8s watch disconnect (410 Gone),
 * then recovery — no network, no re-implemented logic. Only ./config,
 * ./k8s-token and ./valkey are mocked, the same way live-k8s-informer.test.ts
 * and live-stream.test.ts already do.
 *
 * The main test below asserts only what the current code actually guarantees.
 * Three real gaps found while writing it are tracked as
 * dasomel/narwhal-portal#178 and pinned as separate `it.fails` cases further
 * down — each asserts the CORRECT behavior (so it starts failing loudly once
 * #178 is fixed, which is the signal to flip it back to `it`), not the
 * current buggy one. Production code is unchanged here.
 */

const state = vi.hoisted(() => ({
  down: false,
  ring: [] as string[],
  counter: BigInt(0),
  kv: new Map<string, string>(),
}))

vi.mock("./config", () => ({ getK8sApiServer: () => "https://kubernetes.default.svc" }))
vi.mock("./k8s-token", () => ({
  getK8sBearerToken: () => "valid-bearer-token",
  invalidateK8sBearerToken: () => {},
}))

// A single fake Valkey deployment behind both clients real code asks for —
// getValkey() (lease + idempotency) and getLiveValkey() (ring + pub/sub) —
// so `state.down` models one outage affecting the whole store, not two.
function fakeSet(key: string, value: string, ...opts: unknown[]) {
  if (state.down) throw new Error("valkey down")
  if (opts.includes("NX") && state.kv.has(key)) return null
  state.kv.set(key, value)
  return "OK"
}

vi.mock("./valkey", () => ({
  getValkey: () => ({
    set: async (key: string, value: string, ...opts: unknown[]) => fakeSet(key, value, ...opts),
    get: async (key: string) => { if (state.down) throw new Error("valkey down"); return state.kv.get(key) ?? null },
    // Renew/release run over Lua on the lease key only; kept independent of
    // `state.down` (unlike acquisition's `set`, which does model the outage)
    // so the informer's own lease bookkeeping never wedges this test on a
    // stale lock — lease coordination fidelity is already covered by
    // live-k8s-informer.test.ts's replica-failover test, not this one.
    eval: async (script: string, _numKeys: number, key: string, ...args: unknown[]) => {
      const token = String(args[0])
      if (state.kv.get(key) !== token) return 0
      if (script.includes("pexpire")) return 1
      state.kv.delete(key)
      return 1
    },
  }),
  getLiveValkey: () => ({
    incr: async () => { if (state.down) throw new Error("valkey down"); state.counter += BigInt(1); return state.counter.toString() },
    pipeline: () => {
      const value: { payload?: string } = {}
      const pipe = {
        lpush: (_k: string, p: string) => { value.payload = p; return pipe },
        ltrim: () => pipe,
        publish: (_k: string, p: string) => { value.payload = p; return pipe },
        exec: async () => { if (state.down) throw new Error("valkey down"); if (value.payload) state.ring.unshift(value.payload); return [] },
      }
      return pipe
    },
    lrange: async (_k: string, start: number, end: number) => {
      if (state.down) throw new Error("valkey down")
      return state.ring.slice(start, end + 1)
    },
  }),
}))

function makeStream(lines: object[]) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"))
      controller.close()
    },
  })
}
function makePendingStream() {
  return new ReadableStream({ start() {} })
}

function k8sEvent(uid: string, rv: string, pod: string) {
  return {
    type: "ADDED",
    object: {
      metadata: { uid, resourceVersion: rv },
      reason: "Failed",
      type: "Warning",
      message: `synthetic event for ${pod}`,
      involvedObject: { kind: "Pod", name: pod, namespace: "default" },
    },
  }
}

describe("live outage / recovery durability (portal#13)", () => {
  let stopInformer: (() => void) | null = null

  beforeEach(() => {
    state.down = false
    state.ring = []
    state.counter = BigInt(0)
    state.kv = new Map()
    vi.clearAllMocks()
  })

  afterEach(() => {
    stopInformer?.()
    stopInformer = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("keeps producing through a store outage and a watch disconnect, then recovers — ingestion, degraded ids, 410 resync, and exact-cursor replay all behave as documented", async () => {
    let watchCalls = 0
    let listCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("limit=1")) {
        listCalls++
        return { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: String(listCalls) } }) } as Response
      }
      watchCalls++
      switch (watchCalls) {
        case 1: // healthy: one event ingests with a real, shared-counter id
          return { ok: true, status: 200, body: makeStream([k8sEvent("uid-a", "10", "pod-a")]) } as unknown as Response
        case 2: // outage begins: the store is down for the rest of this stream
          state.down = true
          return { ok: true, status: 200, body: makeStream([k8sEvent("uid-b", "11", "pod-b"), k8sEvent("uid-c", "12", "pod-c")]) } as unknown as Response
        case 3: // watch disconnect while still degraded (410 Gone -> resync)
          return { ok: false, status: 410 } as Response
        case 4: // recovery: the store is back before this stream is processed
          state.down = false
          return { ok: true, status: 200, body: makeStream([k8sEvent("uid-d", "13", "pod-d")]) } as unknown as Response
        default:
          return { ok: true, status: 200, body: makePendingStream() } as unknown as Response
      }
    }))

    const liveStream = await import("./live-stream")
    const pushSpy = vi.spyOn(liveStream, "pushEvent")
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    startLiveK8sInformer()
    await vi.waitFor(() => expect(watchCalls).toBeGreaterThanOrEqual(5), { timeout: 3000 })
    await vi.waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(4), { timeout: 3000 })

    const [a, b, c, d] = await Promise.all(pushSpy.mock.results.map((r) => r.value as Promise<LiveEvent>))
    expect([a, b, c, d].map((e) => e.title)).toEqual([
      "Pod pod-a — Failed", "Pod pod-b — Failed", "Pod pod-c — Failed", "Pod pod-d — Failed",
    ])

    // Ingested while healthy: a real, shared-counter id.
    expect(a.id).toMatch(/^\d+$/)
    // Ingested during the outage: INCR was unreachable, so a process-local
    // `d-` id was minted instead of dropping the event (live-stream.ts:88-96).
    expect(b.id).toMatch(/^d-/)
    expect(c.id).toMatch(/^d-/)
    // Recovery resumed the shared counter cleanly.
    expect(d.id).toMatch(/^\d+$/)

    // Guaranteed fallback: a client that already holds the exact degraded
    // cursor (e.g. one that stayed connected through the outage) still finds
    // every subsequent event, in order, once Valkey recovers
    // (live-stream.ts:151-156).
    const exactCursorReplay = await liveStream.replayAfter(b.id)
    expect(exactCursorReplay).toMatchObject({ gap: false, unknown: false })
    expect(exactCursorReplay.events.map((e) => e.title)).toEqual(["Pod pod-c — Failed", "Pod pod-d — Failed"])

    // Metrics observed the outage, the 410 resync, and the recovery, matching
    // the admin health view.
    const informerStatus = getLiveK8sInformerStatus()
    expect(informerStatus.resyncs410).toBe(1)
    const streamMetrics = liveStream.getLiveStreamMetrics()
    expect(streamMetrics.degradedEntries).toBeGreaterThanOrEqual(1)
    expect(streamMetrics.recoveries).toBeGreaterThanOrEqual(1)
  }, 10_000)

  // --- dasomel/narwhal-portal#178 — three known gaps, pinned as expected
  // failures. Each asserts the CORRECT behavior; flip to `it` once #178 is
  // fixed and the assertion starts passing for real.

  it.fails("#178 gap 1: a numeric-cursor replay after recovery should not silently omit an event that only ever lived in the process-local ring — it should either return the event or report a gap", async () => {
    const { pushEvent, replayAfter } = await import("./live-stream")
    const before = await pushEvent({ type: "custom", severity: "info", title: "before-outage", description: "before-outage", source: "manual" })
    state.down = true
    const lost = await pushEvent({ type: "custom", severity: "info", title: "during-outage", description: "during-outage", source: "manual" })
    state.down = false
    await pushEvent({ type: "custom", severity: "info", title: "after-recovery", description: "after-recovery", source: "manual" })

    const result = await replayAfter(before.id)
    const sawLostEvent = result.events.some((e) => e.id === lost.id)
    expect(sawLostEvent || result.gap || result.unknown).toBe(true)
  })

  it.fails("#178 gap 2: an idempotency key claimed only during a Valkey outage should still be honored once Valkey recovers — a redelivery must not re-ingest", async () => {
    const { ValkeyIdempotencyStore, claimIdempotencyKey } = await import("./idempotency")
    const store = new ValkeyIdempotencyStore()

    state.down = true
    const first = await claimIdempotencyKey(store, "source-event:kubernetes:uid-x:1", "event-1", 3600)
    expect(first).toBeNull() // first delivery: not a duplicate, claimed via the in-memory fallback

    state.down = false
    const redeliveredAfterRecovery = await claimIdempotencyKey(store, "source-event:kubernetes:uid-x:1", "event-2", 3600)
    expect(redeliveredAfterRecovery).toBe("event-1") // correct: dedup should survive the recovery
  })

  it.fails("#178 gap 3: after a 410, the informer should account for events between the expired cursor and the fresh resourceVersion instead of silently skipping them (live-k8s-informer.ts ~L136, ~L302)", async () => {
    let watchCalls = 0
    let listCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("limit=1")) {
        listCalls++
        // A real `GET /api/v1/events?limit=1` list response carries `items`
        // (here: the one event that happened during the gap window) even
        // though getLatestResourceVersion() only ever reads
        // `metadata.resourceVersion` (live-k8s-informer.ts:136-146) and
        // silently discards `items` — so a resync after 410 never learns
        // about, replays, or flags the events it skipped.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            metadata: { resourceVersion: "5" },
            items: listCalls === 1 ? [] : [{ metadata: { uid: "uid-missed", resourceVersion: "5" }, reason: "Failed", type: "Warning", involvedObject: { kind: "Pod", name: "pod-missed", namespace: "default" } }],
          }),
        } as unknown as Response
      }
      watchCalls++
      if (watchCalls === 1) return { ok: true, status: 200, body: makeStream([k8sEvent("uid-e1", "2", "pod-e1")]) } as unknown as Response
      if (watchCalls === 2) return { ok: false, status: 410 } as Response
      return { ok: true, status: 200, body: makePendingStream() } as unknown as Response
    }))

    const liveStream = await import("./live-stream")
    const pushSpy = vi.spyOn(liveStream, "pushEvent")
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    startLiveK8sInformer()
    await vi.waitFor(() => expect(getLiveK8sInformerStatus().resyncs410).toBe(1), { timeout: 3000 })
    await vi.waitFor(() => expect(watchCalls).toBeGreaterThanOrEqual(3), { timeout: 3000 })

    // Correct: the event the post-410 relist already knows about (uid-missed,
    // resourceVersion "5") should be ingested, not silently dropped between
    // the expired watch (last seen rv "2") and the fresh one.
    expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Pod pod-missed — Failed" }))
  })
})
