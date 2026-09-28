import { beforeEach, describe, expect, it, vi } from "vitest"

const metrics = { connectedClients: 0, disconnectCleanups: 0 }
const streamState = { failSetup: false }

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { role: "admin" }, groups: [], teams: [] })) }))
vi.mock("@/lib/scope", () => ({ getEffectiveScope: vi.fn(async () => ({})) }))
vi.mock("@/lib/event-visibility", () => ({ isEventFiltered: vi.fn(() => false) }))
vi.mock("@/lib/live-stream", () => ({
  compareLiveEventIds: vi.fn(() => 1),
  connectLiveClient: vi.fn(() => { metrics.connectedClients++ }),
  disconnectLiveClient: vi.fn(() => { metrics.connectedClients = Math.max(0, metrics.connectedClients - 1); metrics.disconnectCleanups++ }),
  getLiveStreamMetrics: vi.fn(() => ({ ...metrics })),
  subscribeLiveWithReplay: vi.fn(async () => {
    if (streamState.failSetup) throw new Error("replay unavailable")
    return { replay: { events: [], gap: false, unknown: false }, live: { async *[Symbol.asyncIterator]() {} }, status: { dependency: "valkey", state: "ok", observedAt: new Date().toISOString() } }
  }),
}))

const { GET } = await import("./route")
const { getLiveStreamMetrics } = await import("@/lib/live-stream")

describe("/api/events/stream client metrics", () => {
  beforeEach(() => {
    metrics.connectedClients = 0
    metrics.disconnectCleanups = 0
    streamState.failSetup = false
    vi.mocked(getLiveStreamMetrics).mockClear()
  })

  it("returns connected clients to zero when the request aborts", async () => {
    const abort = new AbortController()
    const response = await GET(new Request("http://localhost/api/events/stream", { signal: abort.signal }))
    const reader = response.body!.getReader()
    await reader.read()
    expect(metrics.connectedClients).toBe(1)

    abort.abort()
    await reader.read()

    expect(getLiveStreamMetrics().connectedClients).toBe(0)
  })

  it("returns connected clients to zero when replay setup throws", async () => {
    streamState.failSetup = true
    const response = await GET(new Request("http://localhost/api/events/stream"))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    await expect(reader.read()).resolves.toMatchObject({ done: true })

    expect(getLiveStreamMetrics().connectedClients).toBe(0)
  })
})
