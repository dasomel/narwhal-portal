import { getLiveValkey } from "./valkey"
import type { LiveEvent, LiveEventIngest } from "@/types/live"

const RING_KEY = "live:events"
const ID_KEY = "live:events:id"
const PUBSUB_CHANNEL = "live:events:chan"
export const LIVE_EVENT_RETENTION = 1000

// Degraded IDs are intentionally incomparable with shared Valkey counters.
let sequence = 0
const memoryRing: LiveEvent[] = []
let degradedReason: string | undefined
let degradedAt = 0

export type LiveStreamStatus = { dependency: "valkey"; state: "ok" | "partial" | "unavailable"; observedAt: string; reason?: string }

function markDegraded(reason = "persistence_failure") {
  if (!degradedReason) console.warn("[live-stream] Valkey unavailable — operating in degraded in-memory mode")
  degradedReason = reason
  degradedAt = Date.now()
  process.env.LIVE_STREAM_DEGRADED = "1"
}

function markHealthy() {
  degradedReason = undefined
  degradedAt = 0
  delete process.env.LIVE_STREAM_DEGRADED
}

export function getLiveStreamStatus(): LiveStreamStatus {
  return {
    dependency: "valkey",
    state: degradedReason ? "partial" : "ok",
    observedAt: new Date(degradedAt || Date.now()).toISOString(),
    ...(degradedReason ? { reason: degradedReason } : {}),
  }
}

function nextMemoryId(): string {
  sequence += 1
  return `d-${Date.now()}-${sequence}`
}

async function nextId(): Promise<string> {
  const valkey = getLiveValkey()
  return String(await valkey.incr(ID_KEY))
}

export async function pushEvent(ingest: LiveEventIngest): Promise<LiveEvent> {
  let id: string
  try {
    id = await nextId()
  } catch {
    markDegraded()
    id = nextMemoryId()
  }
  const event: LiveEvent = {
    id, type: ingest.type, severity: ingest.severity,
    timestamp: new Date().toISOString(), title: ingest.title, description: ingest.description,
    source: ingest.source, links: ingest.links ?? null, resource: ingest.resource ?? null,
    actor: ingest.actor ?? null, operation_id: ingest.operation_id ?? null,
    correlation_id: ingest.correlation_id ?? null, causation_id: ingest.causation_id ?? null,
    request_id: ingest.request_id ?? null, idempotency_key: ingest.idempotency_key ?? null,
    source_event_id: ingest.source_event_id ?? null, event_type: ingest.event_type ?? null,
    visibility: ingest.visibility ?? null, producer: ingest.producer ?? null,
    credential_scope: ingest.credential_scope ?? null,
  }

  memoryRing.unshift(event)
  if (memoryRing.length > LIVE_EVENT_RETENTION) memoryRing.splice(LIVE_EVENT_RETENTION)

  try {
    const valkey = getLiveValkey()
    await valkey.pipeline().lpush(RING_KEY, JSON.stringify(event)).ltrim(RING_KEY, 0, LIVE_EVENT_RETENTION - 1)
      .publish(PUBSUB_CHANNEL, JSON.stringify(event)).exec()
    if (/^\d+$/.test(id)) markHealthy()
  } catch {
    markDegraded()
  }
  return event
}

export async function getRecentEvents(limit: number): Promise<LiveEvent[]> {
  try {
    const items = await getLiveValkey().lrange(RING_KEY, 0, limit - 1)
    markHealthy()
    return items.map((item) => JSON.parse(item) as LiveEvent)
  } catch {
    markDegraded()
    return memoryRing.slice(0, limit)
  }
}

export type ReplayResult = { events: LiveEvent[]; gap: boolean; unknown: boolean }

export function compareLiveEventIds(left: string, right: string): number | null {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null
  const a = BigInt(left), b = BigInt(right)
  return a === b ? 0 : a < b ? -1 : 1
}

export async function replayAfter(lastId: string, limit = LIVE_EVENT_RETENTION): Promise<ReplayResult> {
  if (lastId.startsWith("d-")) {
    const localOrdered = memoryRing.slice().reverse()
    const localIndex = localOrdered.findIndex((event) => event.id === lastId)
    if (localIndex < 0) return { events: [], gap: false, unknown: true }
    return { events: localOrdered.slice(localIndex + 1), gap: false, unknown: false }
  }
  const newestFirst = await getRecentEvents(limit)
  const ordered = newestFirst.filter((event) => /^\d+$/.test(event.id)).slice().reverse()
  const newest = ordered.at(-1)
  const oldest = ordered[0]
  const newestComparison = newest && compareLiveEventIds(lastId, newest.id)
  const oldestComparison = oldest && compareLiveEventIds(lastId, oldest.id)
  const index = ordered.findIndex((event) => event.id === lastId)
  if (!newest || newestComparison === undefined || newestComparison === null || oldestComparison === undefined || oldestComparison === null || newestComparison > 0) {
    return { events: [], gap: false, unknown: true }
  }
  if (oldestComparison < 0) return { events: [], gap: true, unknown: false }
  if (index < 0) return { events: [], gap: false, unknown: true }
  return { events: ordered.slice(index + 1), gap: false, unknown: false }
}

export async function* subscribeLive(afterId?: string, signal?: AbortSignal): AsyncIterable<LiveEvent> {
  if (signal?.aborted) return
  let subscriber: ReturnType<typeof getLiveValkey> | null = null
  try { subscriber = getLiveValkey().duplicate() } catch { markDegraded() }
  if (!subscriber) return

  const queue: LiveEvent[] = []
  let resolve: (() => void) | null = null
  const listener = (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as LiveEvent
      queue.push(event)
      resolve?.()
      resolve = null
    } catch { /* Ignore malformed pub/sub payload. */ }
  }
  const wake = () => { resolve?.(); resolve = null }
  try {
    subscriber.on("message", listener)
    signal?.addEventListener("abort", wake)
    try {
      await subscriber.subscribe(PUBSUB_CHANNEL)
    } catch (error) {
      markDegraded("subscription_failure")
      throw error
    }
    while (!signal?.aborted) {
      if (queue.length === 0) await new Promise<void>((r) => { resolve = r })
      while (queue.length) yield queue.shift()!
    }
  } finally {
    signal?.removeEventListener("abort", wake)
    try {
      subscriber.removeListener("message", listener)
      await subscriber.unsubscribe(PUBSUB_CHANNEL)
      subscriber.disconnect()
    } catch { /* cleanup */ }
  }
}

export async function subscribeLiveWithReplay(afterId?: string, signal?: AbortSignal): Promise<{
  replay: ReplayResult | null
  live: AsyncIterable<LiveEvent>
  status: LiveStreamStatus
}> {
  // Subscribe first; events arriving while the snapshot is read are queued, then
  // filtered by the snapshot's high-water ID by the route.
  const live: AsyncIterable<LiveEvent> = {
    [Symbol.asyncIterator]: () => subscribeLive(afterId, signal)[Symbol.asyncIterator](),
  }
  const replay = afterId ? await replayAfter(afterId) : { events: (await getRecentEvents(50)).reverse(), gap: false, unknown: false }
  return { replay, live, status: getLiveStreamStatus() }
}
