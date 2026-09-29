import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "@/app/api/events/ingest/route"
import { InMemoryIdempotencyStore, setIdempotencyStoreForTesting } from "@/lib/idempotency"
import { TokenBucketRateLimiter, resetIngestMetricsForTesting, setRateLimiterForTesting } from "@/lib/event-ingest"

const state = vi.hoisted(() => ({ ring: [] as string[], counter: BigInt(100) }))

vi.mock("@/lib/valkey", () => ({
  getLiveValkey: () => ({
    incr: async () => { state.counter += BigInt(1); return state.counter.toString() },
    pipeline: () => {
      let pending: string | undefined
      const pipe = {
        lpush: (_key: string, value: string) => { pending = value; return pipe },
        ltrim: () => pipe,
        publish: () => pipe,
        exec: async () => { if (pending) state.ring.unshift(pending); return [[null, 1]] },
      }
      return pipe
    },
    lrange: async (_key: string, start: number, end: number) => state.ring.slice(start, end + 1),
  }),
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }))

const { getRecentEvents, replayAfter } = await import("@/lib/live-stream")

function ingestRequest(schemaVersion: unknown, idempotencyKey: string) {
  return new Request("http://localhost:3000/api/events/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Secret": "manual-secret", "X-Producer-Id": "manual" },
    body: JSON.stringify({
      type: "custom", severity: "info", title: "Version probe", source: "manual",
      idempotency_key: idempotencyKey, schema_version: schemaVersion,
    }),
  })
}

describe("event schema version current behavior", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, LIVE_INGEST_SECRET_MANUAL: "manual-secret" }
    state.ring = []
    state.counter = BigInt(100)
    setIdempotencyStoreForTesting(new InMemoryIdempotencyStore())
    setRateLimiterForTesting(new TokenBucketRateLimiter(50, 10))
    resetIngestMetricsForTesting()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    setIdempotencyStoreForTesting(null)
    setRateLimiterForTesting(null)
    resetIngestMetricsForTesting()
  })

  it("replays unversioned and 1.0 records in order without synthesizing schema_version", async () => {
    const stored = (id: string, title: string, extra: object = {}) => JSON.stringify({
      id, type: "custom", severity: "info", timestamp: "2026-09-30T00:00:00.000Z", title,
      description: "", source: "manual", ...extra,
    })
    state.ring = [stored("102", "v1", { schema_version: "1.0" }), stored("101", "legacy"), stored("100", "cursor")]

    const replay = await replayAfter("100")

    expect(replay).toMatchObject({ gap: false, unknown: false })
    expect(replay.events.map((event) => event.title)).toEqual(["legacy", "v1"])
    expect((replay.events[0] as unknown as Record<string, unknown>).schema_version).toBeUndefined()
    expect((replay.events[1] as unknown as Record<string, unknown>).schema_version).toBe("1.0")
  })

  it.each([1, true, "", "2.0", "99.0"])("currently accepts schema_version %s and drops it from the ingested event", async (schemaVersion) => {
    const response = await POST(ingestRequest(schemaVersion, `version-${String(schemaVersion)}`))

    expect(response.status).toBe(200)
    expect((await response.json()).ok).toBe(true)
    expect(state.ring).toHaveLength(1)
    expect((JSON.parse(state.ring[0]) as Record<string, unknown>).schema_version).toBeUndefined()
  })

  it("currently replays an unsupported stored schema_version without gating", async () => {
    state.ring = [JSON.stringify({ id: "101", type: "custom", severity: "info", title: "unknown", source: "manual", schema_version: "99.0" })]

    const events = await getRecentEvents(1)

    expect(events).toHaveLength(1)
    expect((events[0] as unknown as Record<string, unknown>).schema_version).toBe("99.0")
  })
})
