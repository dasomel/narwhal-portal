import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { setIdempotencyStoreForTesting, InMemoryIdempotencyStore, idempotencyStoreKey } from "./idempotency"
import type { IdempotencyStore } from "./idempotency"

import type { LiveEventIngest } from "@/types/live"

/** Wraps InMemoryIdempotencyStore to record every raw key passed to claim() — used
 * to assert the informer builds the same `source-event:<source>:<id>` shape
 * /api/events/ingest dedups on (portal#18-64), not just that dedup happens at all. */
class SpyIdempotencyStore implements IdempotencyStore {
  claimedKeys: string[] = []
  private inner = new InMemoryIdempotencyStore()

  async claim(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    this.claimedKeys.push(key)
    return this.inner.claim(key, value, ttlSeconds)
  }

  async fulfill(key: string, value: string, ttlSeconds: number): Promise<void> {
    return this.inner.fulfill(key, value, ttlSeconds)
  }
}

const mockGetK8sApiServer = vi.fn(() => "https://kubernetes.default.svc")
const mockGetK8sBearerToken = vi.fn(() => "initial-token")
const mockInvalidateK8sBearerToken = vi.fn()
const mockPushEvent = vi.fn(async (ingest: LiveEventIngest): Promise<void> => { void ingest })
const valkeyState = vi.hoisted(() => ({ value: null as string | null, expiresAt: 0, down: false, rejectRelease: false }))
const mockLeaseValkey = {
  set: vi.fn(async (_key: string, value: string, ...options: unknown[]) => {
    if (valkeyState.down) throw new Error("Valkey down")
    if (valkeyState.value && valkeyState.expiresAt <= Date.now()) valkeyState.value = null
    if (valkeyState.value) return null
    valkeyState.value = value
    valkeyState.expiresAt = Date.now() + Number(options[1] ?? 15000)
    return "OK"
  }),
  eval: vi.fn(async (script: string, _keys: number, _key: string, ...args: unknown[]) => {
    if (valkeyState.down) throw new Error("Valkey down")
    const token = String(args[0])
    if (valkeyState.expiresAt <= Date.now()) return 0
    if (valkeyState.value !== token) return 0
    if (script.includes("pexpire")) {
      valkeyState.expiresAt = Date.now() + Number(args[1])
      return 1
    }
    if (valkeyState.rejectRelease) return 0
    valkeyState.value = null
    return 1
  }),
}

vi.mock("./config", () => ({
  getK8sApiServer: () => mockGetK8sApiServer(),
}))

vi.mock("./k8s-token", () => ({
  getK8sBearerToken: () => mockGetK8sBearerToken(),
  invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
}))

vi.mock("./live-stream", () => ({
  pushEvent: (ingest: LiveEventIngest) => mockPushEvent(ingest),
}))

vi.mock("./valkey", () => ({ getValkey: () => mockLeaseValkey }))

function makeStream(lines: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"))
      }
      controller.close()
    },
  })
}

function makePendingStream() {
  return new ReadableStream({
    start() {},
  })
}

describe("live-k8s-informer", () => {
  const originalEnv = { ...process.env }
  let stopInformer: (() => void) | null = null

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.NEXT_RUNTIME // ensure nodejs runtime check passes
    vi.clearAllMocks()
    valkeyState.value = null
    valkeyState.expiresAt = 0
    valkeyState.down = false
    valkeyState.rejectRelease = false
    setIdempotencyStoreForTesting(new InMemoryIdempotencyStore())
    mockGetK8sApiServer.mockReturnValue("https://kubernetes.default.svc")
    mockGetK8sBearerToken.mockReturnValue("valid-bearer-token")
  })

  afterEach(async () => {
    if (stopInformer) {
      stopInformer()
      stopInformer = null
    }
    setIdempotencyStoreForTesting(null)
    process.env = originalEnv
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("filters events by reason: allowlisted Normal and all Warning events ingested, unallowlisted Normal dropped", async () => {
    const events = [
      // 1. Allowlisted Normal event -> should ingest
      {
        type: "ADDED",
        object: {
          metadata: { uid: "uid-norm-allowed", resourceVersion: "101" },
          reason: "Scheduled",
          type: "Normal",
          message: "Successfully assigned default/pod-1 to node-1",
          involvedObject: { kind: "Pod", name: "pod-1", namespace: "default" },
        },
      },
      // 2. Unallowlisted Normal event -> should be dropped
      {
        type: "ADDED",
        object: {
          metadata: { uid: "uid-norm-dropped", resourceVersion: "102" },
          reason: "SandboxChanged",
          type: "Normal",
          message: "Pod sandbox changed",
          involvedObject: { kind: "Pod", name: "pod-2", namespace: "default" },
        },
      },
      // 3. Warning event (any reason) -> should ingest
      {
        type: "ADDED",
        object: {
          metadata: { uid: "uid-warn", resourceVersion: "103" },
          reason: "FailedMount",
          type: "Warning",
          message: "MountVolume.SetUp failed for volume",
          involvedObject: { kind: "Pod", name: "pod-3", namespace: "default" },
        },
      },
      // 4. Cluster-scoped allowlisted Normal event (Node) -> should ingest with cluster visibility
      {
        type: "ADDED",
        object: {
          metadata: { uid: "uid-node-ready", resourceVersion: "104" },
          reason: "NodeReady",
          type: "Normal",
          message: "Node is ready",
          involvedObject: { kind: "Node", name: "node-1" },
        },
      },
    ]

    let watchCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/v1/events?limit=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { resourceVersion: "100" } }),
        } as Response
      }
      if (url.includes("watch=1")) {
        watchCalls++
        if (watchCalls === 1) {
          return {
            ok: true,
            status: 200,
            body: makeStream(events.map((e) => JSON.stringify(e))),
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          body: makePendingStream(),
        } as unknown as Response
      }
      return { ok: false, status: 404 } as Response
    }))

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    startLiveK8sInformer()

    await vi.waitFor(() => {
      expect(mockPushEvent).toHaveBeenCalledTimes(3)
    })

    const pushedTitles = mockPushEvent.mock.calls.map(([call]) => call.title)
    expect(pushedTitles).toContain("Pod pod-1 — Scheduled")
    expect(pushedTitles).not.toContain("Pod pod-2 — SandboxChanged")
    expect(pushedTitles).toContain("Pod pod-3 — FailedMount")
    expect(pushedTitles).toContain("Node node-1 — NodeReady")

    // Check visibility and types
    const pod1Call = mockPushEvent.mock.calls.find(([c]) => c.title.includes("pod-1"))?.[0]
    expect(pod1Call).toMatchObject({
      type: "deploy",
      severity: "info",
      visibility: "namespace",
      resource: { kind: "Pod", name: "pod-1", namespace: "default" },
    })

    const pod3Call = mockPushEvent.mock.calls.find(([c]) => c.title.includes("pod-3"))?.[0]
    expect(pod3Call).toMatchObject({
      type: "alert",
      severity: "warning",
      visibility: "namespace",
    })

    const nodeCall = mockPushEvent.mock.calls.find(([c]) => c.title.includes("node-1"))?.[0]
    expect(nodeCall).toMatchObject({
      type: "node",
      severity: "info",
      visibility: "cluster",
    })
  })

  it("deduplicates duplicate delivery: same uid/resourceVersion delivered twice results in at most one ingested event", async () => {
    const spyStore = new SpyIdempotencyStore()
    setIdempotencyStoreForTesting(spyStore)

    const duplicateEvent = {
      type: "ADDED",
      object: {
        metadata: { uid: "uid-dup-1", resourceVersion: "500" },
        reason: "Started",
        type: "Normal",
        message: "Started container",
        involvedObject: { kind: "Pod", name: "app-1", namespace: "prod" },
      },
    }

    const uniqueEvent = {
      type: "ADDED",
      object: {
        metadata: { uid: "uid-unique-2", resourceVersion: "501" },
        reason: "Started",
        type: "Normal",
        message: "Started container 2",
        involvedObject: { kind: "Pod", name: "app-2", namespace: "prod" },
      },
    }

    let watchCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/v1/events?limit=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { resourceVersion: "499" } }),
        } as Response
      }
      if (url.includes("watch=1")) {
        watchCalls++
        if (watchCalls === 1) {
          // Stream receives duplicateEvent twice and uniqueEvent once
          return {
            ok: true,
            status: 200,
            body: makeStream([
              JSON.stringify(duplicateEvent),
              JSON.stringify(duplicateEvent), // Duplicate in same stream
              JSON.stringify(uniqueEvent),
            ]),
          } as unknown as Response
        }
        if (watchCalls === 2) {
          // Reconnect/replay receives duplicateEvent again
          return {
            ok: true,
            status: 200,
            body: makeStream([JSON.stringify(duplicateEvent)]),
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          body: makePendingStream(),
        } as unknown as Response
      }
      return { ok: false, status: 404 } as Response
    }))

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    startLiveK8sInformer()

    // Wait until the replay stream (call 2) has been fully consumed and the loop
    // has moved on to call 3 — otherwise the count below could be read before the
    // replayed duplicate arrives and the assertion would prove nothing.
    await vi.waitFor(() => {
      expect(watchCalls).toBeGreaterThanOrEqual(3)
    })
    expect(mockPushEvent).toHaveBeenCalledTimes(2)

    const app1Calls = mockPushEvent.mock.calls.filter(([c]) => c.title.includes("app-1"))
    const app2Calls = mockPushEvent.mock.calls.filter(([c]) => c.title.includes("app-2"))

    expect(app1Calls.length).toBe(1)
    expect(app2Calls.length).toBe(1)

    // The claimed key must equal the ingest-format key so an event delivered both
    // via this informer and via /api/events/ingest dedups against the other.
    expect(spyStore.claimedKeys).toContain(idempotencyStoreKey("source-event:kubernetes:uid-dup-1:500"))
  })

  it("handles watch 401: invalidates token and retries watch with refreshed token", async () => {
    let watchAttempt = 0
    const capturedAuthHeaders: (string | null)[] = []

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/v1/events?limit=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ metadata: { resourceVersion: "300" } }),
        } as Response
      }
      if (url.includes("watch=1")) {
        watchAttempt++
        const headers = init?.headers as Record<string, string> | undefined
        capturedAuthHeaders.push(headers?.Authorization ?? null)

        if (watchAttempt === 1) {
          // Simulate 401 unauthorized on first watch
          return {
            ok: false,
            status: 401,
          } as Response
        }

        if (watchAttempt === 2) {
          // Second watch succeeds
          return {
            ok: true,
            status: 200,
            body: makeStream([
              JSON.stringify({
                type: "ADDED",
                object: {
                  metadata: { uid: "uid-post-401", resourceVersion: "301" },
                  reason: "Scheduled",
                  type: "Normal",
                  involvedObject: { kind: "Pod", name: "recovered-pod", namespace: "default" },
                },
              }),
            ]),
          } as unknown as Response
        }

        return {
          ok: true,
          status: 200,
          body: makePendingStream(),
        } as unknown as Response
      }
      return { ok: false, status: 404 } as Response
    }))

    let currentToken = "stale-expired-token"
    mockGetK8sBearerToken.mockImplementation(() => currentToken)
    mockInvalidateK8sBearerToken.mockImplementation(() => {
      currentToken = "fresh-rotated-token"
    })

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    startLiveK8sInformer()

    await vi.waitFor(() => {
      expect(mockInvalidateK8sBearerToken).toHaveBeenCalledTimes(1)
      expect(mockPushEvent).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Pod recovered-pod — Scheduled" }),
      )
    }, { timeout: 3000 })

    expect(capturedAuthHeaders[0]).toBe("Bearer stale-expired-token")
    expect(capturedAuthHeaders[1]).toBe("Bearer fresh-rotated-token")
  })

  it.each([
    { status: 401, phase: "list" },
    { status: 403, phase: "list" },
    { status: 401, phase: "watch" },
    { status: 403, phase: "watch" },
  ])("reports sanitized $status credential diagnostics from $phase", async ({ status, phase }) => {
    const sentinel = "informer-secret-token-sentinel-54"
    mockGetK8sBearerToken.mockReturnValue(sentinel)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const fetchMock = vi.fn(async (url: string) => {
      if (phase === "list" || url.includes("watch=1")) return new Response(null, { status })
      return Response.json({ metadata: { resourceVersion: "1" } })
    })
    vi.stubGlobal("fetch", fetchMock)

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      "[live-k8s-informer] watch error, retrying:",
      expect.stringContaining(`K8s API ${status}`),
    ))
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain("K8S_SA_TOKEN_FILE")
    expect(logged).not.toContain(sentinel)
    expect(mockInvalidateK8sBearerToken).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
  })

  it("cleanly disables informer when no bearer token is available (no throw, no network call)", async () => {
    mockGetK8sBearerToken.mockReturnValue("") // empty token
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    expect(() => startLiveK8sInformer()).not.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockPushEvent).not.toHaveBeenCalled()
  })

  it("cleanly disables informer when getK8sBearerToken throws (e.g. unconfigured)", async () => {
    mockGetK8sBearerToken.mockImplementation(() => {
      throw new Error("Missing required production configuration: K8S_SA_TOKEN_FILE")
    })
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting

    expect(() => startLiveK8sInformer()).not.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockPushEvent).not.toHaveBeenCalled()
  })

  it("falls back to a local watch and reports it when Valkey is down", async () => {
    valkeyState.down = true
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("limit=1")
      ? { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: "1" } }) } as Response
      : { ok: true, status: 200, body: makePendingStream() } as unknown as Response))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(getLiveK8sInformerStatus().ownerState).toBe("local-fallback"))
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining("watch=1"), expect.anything())
  })

  it("allows one of two replicas to watch, then takes over after the owner's lease expires", async () => {
    vi.useFakeTimers()
    let watchCalls = 0
    let listCalls = 0
    const watchVersions: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("limit=1")
      ? (listCalls++, { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: String(listCalls) } }) } as Response)
      : (watchVersions.push(new URL(url).searchParams.get("resourceVersion") ?? ""), watchCalls++, { ok: true, status: 200, body: makePendingStream() } as unknown as Response)))
    const replica1 = await import("./live-k8s-informer")
    replica1.startLiveK8sInformer()
    await vi.waitFor(() => expect(watchCalls).toBe(1))

    vi.resetModules()
    const replica2 = await import("./live-k8s-informer")
    replica2.startLiveK8sInformer()
    await vi.waitFor(() => expect(replica2.getLiveK8sInformerStatus().ownerState).toBe("standby"))
    expect(watchCalls).toBe(1)

    // Model process loss: its watch aborts, but it cannot run the token-checked release.
    valkeyState.rejectRelease = true
    replica1.stopLiveK8sInformerForTesting()
    await vi.advanceTimersByTimeAsync(20_000) // TTL + one 5s standby polling tick
    await vi.waitFor(() => expect(watchCalls).toBe(2))
    expect(replica2.getLiveK8sInformerStatus().leaseAcquisitions).toBe(1)
    expect(listCalls).toBe(2)
    expect(watchVersions).toEqual(["1", "2"])
    replica2.stopLiveK8sInformerForTesting()
    vi.useRealTimers()
    stopInformer = null
  }, 15_000)

  it("rejects lease renew and release attempts with a foreign token", async () => {
    await mockLeaseValkey.set("live:k8s-informer:lease", "owner-token")
    expect(await mockLeaseValkey.eval("pexpire", 1, "live:k8s-informer:lease", "foreign-token", 15000)).toBe(0)
    expect(await mockLeaseValkey.eval("del", 1, "live:k8s-informer:lease", "foreign-token")).toBe(0)
    expect(valkeyState.value).toBe("owner-token")
    expect(await mockLeaseValkey.eval("del", 1, "live:k8s-informer:lease", "owner-token")).toBe(1)
    expect(valkeyState.value).toBeNull()
  })

  it("recovers multiple events after 410 before resuming the watch", async () => {
    let lists = 0
    let watches = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.includes("watch=1")) {
        lists++
        return new Response(JSON.stringify({ metadata: { resourceVersion: String(lists) }, items: lists === 1 ? [] : [
          { type: "Warning", reason: "Failed", metadata: { uid: "gap-a", resourceVersion: "a" } },
          { type: "Warning", reason: "Failed", metadata: { uid: "gap-b", resourceVersion: "b" } },
        ] }))
      }
      watches++
      if (watches === 1) return { ok: false, status: 410 } as Response
      return { ok: true, status: 200, body: makePendingStream() } as unknown as Response
    }))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(getLiveK8sInformerStatus().resyncs410).toBe(1))
    expect(lists).toBe(2)
    expect(watches).toBe(2)
    expect(mockPushEvent.mock.calls.map(([ingest]) => ingest.source_event_id)).toEqual(["gap-a:a", "gap-b:b"])
  })

  it("waits for acceptance before submitting the next watch event", async () => {
    let acceptFirst!: () => void
    mockPushEvent.mockImplementationOnce(() => new Promise<void>((resolve) => { acceptFirst = resolve }))
    const event = (uid: string) => JSON.stringify({ type: "ADDED", object: {
      type: "Warning", reason: "Failed", metadata: { uid, resourceVersion: uid },
    } })
    let watches = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.includes("watch=1")) return new Response(JSON.stringify({ metadata: { resourceVersion: "1" }, items: [] }))
      watches++
      return { ok: true, status: 200, body: watches === 1
        ? makeStream([event("first"), event("second")]) : makePendingStream() } as unknown as Response
    }))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(mockPushEvent).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockPushEvent).toHaveBeenCalledTimes(1)
    expect(watches).toBe(1)
    acceptFirst()
    await vi.waitFor(() => expect(mockPushEvent).toHaveBeenCalledTimes(2))
    expect(mockPushEvent.mock.calls.map(([ingest]) => ingest.source_event_id)).toEqual(["first:first", "second:second"])
  })

  it("keeps resourceVersion across owner reconnects", async () => {
    const watchVersions: string[] = []
    let watches = 0
    let lists = 0
    const event = (rv: string) => JSON.stringify({ type: "ADDED", object: { type: "Warning", reason: "Failed", metadata: { uid: rv, resourceVersion: rv } } })
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("limit=1")) {
        lists++
        return { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: "1" } }) } as Response
      }
      watchVersions.push(new URL(url).searchParams.get("resourceVersion") ?? "")
      watches++
      return { ok: true, status: 200, body: watches < 3 ? makeStream([event(String(watches + 1))]) : makePendingStream() } as unknown as Response
    }))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(watches).toBe(3))
    expect(lists).toBe(1)
    expect(watchVersions).toEqual(["1", "2", "3"])
  })

  it("discards an oversized partial line once and resumes at the next event", async () => {
    const encoder = new TextEncoder()
    const validEvent = JSON.stringify({ type: "ADDED", object: { type: "Warning", reason: "Failed", metadata: { uid: "after-overflow", resourceVersion: "2" }, involvedObject: { kind: "Pod", name: "valid-pod" } } })
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{" + "x".repeat(1024 * 1024 + 10)))
        controller.enqueue(encoder.encode("\n" + validEvent + "\n"))
        controller.close()
      },
    })
    let watches = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("limit=1")) return { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: "1" } }) } as Response
      watches++
      return { ok: true, status: 200, body: watches === 1 ? oversizedStream : makePendingStream() } as unknown as Response
    }))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(mockPushEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "Pod valid-pod — Failed" })))
    expect(getLiveK8sInformerStatus().droppedByBackpressure).toBe(1)
  })

  it("drains complete event lines before applying the partial-line limit", async () => {
    const encoder = new TextEncoder()
    const eventLines = Array.from({ length: 6000 }, (_, index) => JSON.stringify({ type: "ADDED", object: { type: "Warning", reason: "Failed", metadata: { uid: `burst-${index}`, resourceVersion: String(index + 1) } } }))
    const burst = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(eventLines.join("\n") + "\n")); controller.close() } })
    let watches = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("limit=1")) return { ok: true, status: 200, json: async () => ({ metadata: { resourceVersion: "1" } }) } as Response
      watches++
      return { ok: true, status: 200, body: watches === 1 ? burst : makePendingStream() } as unknown as Response
    }))
    const { startLiveK8sInformer, stopLiveK8sInformerForTesting, getLiveK8sInformerStatus } = await import("./live-k8s-informer")
    stopInformer = stopLiveK8sInformerForTesting
    startLiveK8sInformer()
    await vi.waitFor(() => expect(mockPushEvent).toHaveBeenCalledTimes(eventLines.length), { timeout: 10_000 })
    expect(getLiveK8sInformerStatus().droppedByBackpressure).toBe(0)
  })
})
