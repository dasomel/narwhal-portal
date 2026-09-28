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
 * Two real behaviors fall out of this that were not previously pinned by a
 * test or precisely documented — both are pre-existing, unchanged by this
 * commit, and now made explicit instead of silent:
 *
 *  1. An event minted entirely during a same-process Valkey outage (a `d-`
 *     degraded id, never written to the shared ring — see live-stream.ts:112-121)
 *     is invisible to a client that reconnects with a real numeric
 *     Last-Event-ID from before the outage: replayAfter() only ever reads
 *     the shared Valkey ring once Valkey is healthy again (live-stream.ts:125-134,
 *     157-158), so it has no way to know a degraded-only event ever existed —
 *     `gap`/`unknown` stay false. The event is NOT lost from the process — the
 *     exact-degraded-id replay branch (live-stream.ts:151-156) still finds it —
 *     but a numeric cursor never learns to ask for it. docs/architecture.md's
 *     "Live event pipeline" table already documents Valkey-unavailable delivery
 *     as best-effort; this test pins the precise boundary of that guarantee.
 *  2. An idempotency claim recorded only in the in-memory fallback during a
 *     Valkey outage (idempotency.ts:119-122) is not consulted once Valkey
 *     recovers: ValkeyIdempotencyStore.claim() (idempotency.ts:107-123) only
 *     checks Valkey's own key when Valkey answers, so a redelivery of the same
 *     event after recovery is treated as new and re-ingested. This means
 *     idempotency is not guaranteed to survive an outage/recovery cycle for a
 *     key whose only successful claim happened while degraded.
 *
 * Neither is fixed here (scope: prove and document, not patch production
 * code). See the report for this task for the follow-up recommendation.
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

  it("keeps producing through a store outage and a watch disconnect, recovers, and every event is either replayable, exact-cursor-replayable, or a known (documented) blind spot — never silently gone", async () => {
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
        case 4: // recovery: the store is back before this stream is processed;
          // uid-b is redelivered (same uid/resourceVersion) after the relist
          state.down = false
          return { ok: true, status: 200, body: makeStream([k8sEvent("uid-b", "11", "pod-b"), k8sEvent("uid-d", "13", "pod-d")]) } as unknown as Response
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
    await vi.waitFor(() => expect(pushSpy).toHaveBeenCalledTimes(5), { timeout: 3000 })

    const pushedEvents = await Promise.all(pushSpy.mock.results.map((r) => r.value as Promise<LiveEvent>))
    const [a, b1, c, b2, d] = pushedEvents
    const titles = pushedEvents.map((e) => e.title)
    expect(titles).toEqual([
      "Pod pod-a — Failed", "Pod pod-b — Failed", "Pod pod-c — Failed",
      "Pod pod-b — Failed", "Pod pod-d — Failed",
    ])

    // Ingested during the outage: no comparable id was ever minted for these.
    expect(a.id).toMatch(/^\d+$/)
    expect(b1.id).toMatch(/^d-/)
    expect(c.id).toMatch(/^d-/)
    // Recovery resumed the shared counter cleanly for both the (buggy) uid-b
    // redelivery and the genuinely new uid-d event.
    expect(b2.id).toMatch(/^\d+$/)
    expect(d.id).toMatch(/^\d+$/)

    // --- Bug 2 (idempotency does not survive outage/recovery): uid-b was
    // claimed once, successfully, during the outage (in-memory fallback only)
    // and should have short-circuited its redelivery after recovery. Instead
    // it ingested a second time. This is the documented gap in
    // idempotency.ts's ValkeyIdempotencyStore.claim() — proven, not fixed.
    expect(pushSpy).toHaveBeenCalledTimes(5) // would be 4 if idempotency survived recovery

    // --- Bug 1 (numeric-cursor blind spot): a client that saw uid-a live and
    // reconnects with Last-Event-ID = a.id after the outage gets a *complete
    // looking* replay (gap: false, unknown: false) that silently omits uid-c
    // (and the original degraded uid-b delivery) — they only ever existed in
    // this process's local ring, which replayAfter() does not consult once
    // Valkey answers again.
    const numericReplay = await liveStream.replayAfter(a.id)
    expect(numericReplay.gap).toBe(false)
    expect(numericReplay.unknown).toBe(false)
    expect(numericReplay.events.map((e) => e.title)).toEqual(["Pod pod-b — Failed", "Pod pod-d — Failed"])
    expect(numericReplay.events.some((e) => e.id === c.id)).toBe(false) // uid-c: gone from this view, no flag raised

    // Nothing is actually deleted, though: the same process's exact-degraded-
    // id replay branch (live-stream.ts:151-156) still has uid-c and both
    // uid-b deliveries — reachable only by a client that already held the
    // exact `d-` cursor (e.g. one that stayed connected through the outage).
    const exactCursorReplay = await liveStream.replayAfter(b1.id)
    expect(exactCursorReplay).toMatchObject({ gap: false, unknown: false })
    expect(exactCursorReplay.events.map((e) => e.title)).toEqual([
      "Pod pod-c — Failed", "Pod pod-b — Failed", "Pod pod-d — Failed",
    ])

    // Metrics observed the outage and the recovery, matching the admin health view.
    const informerStatus = getLiveK8sInformerStatus()
    expect(informerStatus.resyncs410).toBe(1)
    const streamMetrics = liveStream.getLiveStreamMetrics()
    expect(streamMetrics.degradedEntries).toBeGreaterThanOrEqual(1)
    expect(streamMetrics.recoveries).toBeGreaterThanOrEqual(1)
  }, 10_000)

  it("an idempotency key claimed only during a Valkey outage is not honored once Valkey recovers (idempotency.ts:107-123)", async () => {
    const { ValkeyIdempotencyStore, claimIdempotencyKey } = await import("./idempotency")
    const store = new ValkeyIdempotencyStore()

    state.down = true
    const first = await claimIdempotencyKey(store, "source-event:kubernetes:uid-x:1", "event-1", 3600)
    expect(first).toBeNull() // first delivery: not a duplicate, claimed via the in-memory fallback

    state.down = false
    const redeliveredAfterRecovery = await claimIdempotencyKey(store, "source-event:kubernetes:uid-x:1", "event-2", 3600)
    // Documented gap: Valkey has no record of the in-memory-only claim, so it
    // answers as if this key had never been claimed. A correctly-surviving
    // dedup would return "event-1" here.
    expect(redeliveredAfterRecovery).toBeNull()
  })
})
