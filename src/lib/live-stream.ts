import { randomUUID } from "crypto"
import { getValkey } from "./valkey"
import type { LiveEvent, LiveEventIngest } from "@/types/live"

const RING_KEY = "live:events"
const PUBSUB_CHANNEL = "live:events:chan"
const MAX_EVENTS = 1000

// Degraded in-memory fallback when Valkey is unavailable
const memoryRing: LiveEvent[] = []
let degraded = false

function markDegraded() {
  if (!degraded) {
    console.warn("[live-stream] Valkey unavailable — operating in degraded in-memory mode")
    process.env.LIVE_STREAM_DEGRADED = "1"
    degraded = true
  }
}

export async function pushEvent(ingest: LiveEventIngest): Promise<LiveEvent> {
  const event: LiveEvent = {
    id: randomUUID(),
    type: ingest.type,
    severity: ingest.severity,
    timestamp: new Date().toISOString(),
    title: ingest.title,
    description: ingest.description,
    source: ingest.source,
    links: ingest.links ?? null,
  }

  const payload = JSON.stringify(event)

  try {
    const valkey = getValkey()
    // LPUSH + LTRIM keeps newest events at index 0; pipeline avoids 3× RTT.
    await valkey
      .pipeline()
      .lpush(RING_KEY, payload)
      .ltrim(RING_KEY, 0, MAX_EVENTS - 1)
      .publish(PUBSUB_CHANNEL, payload)
      .exec()
    degraded = false
    delete process.env.LIVE_STREAM_DEGRADED
  } catch {
    markDegraded()
    // Maintain in-memory ring
    memoryRing.unshift(event)
    if (memoryRing.length > MAX_EVENTS) {
      memoryRing.splice(MAX_EVENTS)
    }
  }

  return event
}

export async function getRecentEvents(limit: number): Promise<LiveEvent[]> {
  if (degraded) {
    return memoryRing.slice(0, limit)
  }

  try {
    const valkey = getValkey()
    const items = await valkey.lrange(RING_KEY, 0, limit - 1)
    return items.map((item) => JSON.parse(item) as LiveEvent)
  } catch {
    markDegraded()
    return memoryRing.slice(0, limit)
  }
}

export async function* subscribeLive(): AsyncIterable<LiveEvent> {
  // Each subscriber needs its own dedicated connection for subscribe mode
  let subscriber: ReturnType<typeof getValkey> | null = null

  try {
    subscriber = getValkey().duplicate()
  } catch {
    markDegraded()
  }

  if (!subscriber) {
    // Degraded: no live pub/sub — yield nothing (caller heartbeats will keep connection alive)
    return
  }

  const queue: LiveEvent[] = []
  let resolve: (() => void) | null = null
  let done = false

  const listener = (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as LiveEvent
      queue.push(event)
      if (resolve) {
        const r = resolve
        resolve = null
        r()
      }
    } catch {
      // Malformed message — skip
    }
  }

  try {
    subscriber.on("message", listener)
    await subscriber.subscribe(PUBSUB_CHANNEL)
  } catch {
    markDegraded()
    try {
      subscriber.disconnect()
    } catch {
      // ignore
    }
    return
  }

  try {
    while (!done) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r
        })
      }
      while (queue.length > 0) {
        yield queue.shift()!
      }
    }
  } finally {
    done = true
    try {
      await subscriber.unsubscribe(PUBSUB_CHANNEL)
      subscriber.disconnect()
    } catch {
      // ignore cleanup errors
    }
  }
}
