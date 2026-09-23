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
const mockPushEvent = vi.fn(async (_ingest: LiveEventIngest): Promise<any> => ({} as any))

vi.mock("./config", () => ({
  getK8sApiServer: () => mockGetK8sApiServer(),
}))

vi.mock("./k8s-token", () => ({
  getK8sBearerToken: () => mockGetK8sBearerToken(),
  invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
}))

vi.mock("./live-stream", () => ({
  pushEvent: (ingest: any) => mockPushEvent(ingest),
}))

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
})
