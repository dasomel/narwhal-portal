import { auth } from "@/lib/auth"
import { compareLiveEventIds, connectLiveClient, disconnectLiveClient, subscribeLiveWithReplay } from "@/lib/live-stream"
import { getEffectiveScope } from "@/lib/scope"
import { isEventFiltered } from "@/lib/event-visibility"
import type { LiveEvent } from "@/types/live"
import type { UserRole } from "@/lib/auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HEARTBEAT_MS = 30_000
function formatSSE(event: LiveEvent): string {
  return `id: ${event.id}\nevent: live\ndata: ${JSON.stringify(event)}\n\n`
}

function formatControl(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const role: UserRole = session.user.role ?? "guest"
  const groups: string[] = session.groups ?? []
  const teams: string[] = session.teams ?? []
  const scope = await getEffectiveScope({ groups, teams })
  const lastEventId = request.headers.get("Last-Event-ID") ?? null

  let cancelStream: (() => void) | undefined
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // controller already closed
        }
      }

      // Open the stream immediately: `retry` sets the browser's reconnect backoff
      // and the comment flushes response headers so EventSource fires `open` right
      // away — the client shows "live" instead of reconnect-storming while we set up.
      enqueue("retry: 5000\n\n")
      enqueue(": connected\n\n")

      let closed = false
      let disconnected = false
      let finishLifetime!: () => void
      const lifetime = new Promise<void>((resolve) => { finishLifetime = resolve })
      const heartbeatTimer: { current?: ReturnType<typeof setInterval> } = {}
      const cleanup = () => {
        if (closed) return
        closed = true
        if (!disconnected) {
          disconnected = true
          disconnectLiveClient()
        }
        if (heartbeatTimer.current) clearInterval(heartbeatTimer.current)
        request.signal.removeEventListener("abort", cleanup)
        try {
          controller.close()
        } catch {
          // already closed
        }
        finishLifetime()
      }
      cancelStream = cleanup

      connectLiveClient()
      try {
        request.signal.addEventListener("abort", cleanup)
        if (request.signal.aborted) cleanup()
        const setup = await subscribeLiveWithReplay(lastEventId ?? undefined, request.signal)
        if (closed) return
        if (lastEventId && setup.replay) {
          if (setup.replay.gap) enqueue(formatControl("replay-gap", { after: lastEventId, state: "gap" }))
          if (setup.replay.unknown) enqueue(formatControl("replay-gap", { after: lastEventId, state: "unknown" }))
        }
        enqueue(formatControl("status", setup.status))
        const replaySlice = setup.replay?.events ?? []
        const replayedIds = new Set(replaySlice.map((event) => event.id))
        const replayHighWaterId = replaySlice.map((event) => event.id).filter((id) => /^\d+$/.test(id)).at(-1)

        for (const event of replaySlice) {
          if (!isEventFiltered(event, role, scope)) {
            enqueue(formatSSE(event))
          }
        }

        heartbeatTimer.current = setInterval(() => {
          enqueue(": heartbeat\n\n")
        }, HEARTBEAT_MS)

        // The stream's lifetime is bound to the CLIENT connection (request abort),
        // NOT to the pub/sub subscription. If pub/sub ends or throws, the heartbeat
        // keeps the response open until the client disconnects.
        void (async () => {
          try {
            for await (const event of setup.live) {
              if (request.signal.aborted) break
              if (/^\d+$/.test(event.id)) {
                if (replayHighWaterId && compareLiveEventIds(event.id, replayHighWaterId) !== 1) continue
              } else {
                if (replayedIds.has(event.id)) continue
              }
              if (!isEventFiltered(event, role, scope)) {
                enqueue(formatSSE(event))
              }
            }
          } catch {
            enqueue(formatControl("status", { dependency: "valkey", state: "partial", observedAt: new Date().toISOString(), reason: "subscription_failure" }))
          }
        })()
        await lifetime
      } finally {
        cleanup()
      }
    },
    cancel() {
      // Consumer cancellation is also a stream end and must release its gauge slot.
      cancelStream?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
