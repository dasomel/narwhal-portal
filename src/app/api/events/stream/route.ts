import { auth } from "@/lib/auth"
import { getRecentEvents, subscribeLive } from "@/lib/live-stream"
import { getVisibilityScope, namespaceMatchesScope } from "@/lib/role-filter"
import type { LiveEvent } from "@/types/live"
import type { UserRole } from "@/lib/auth"

type Scope = ReturnType<typeof getVisibilityScope>

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HEARTBEAT_MS = 30_000
const DEFAULT_REPLAY = 50
const MAX_EVENTS_REPLAY = 1000
const NS_RE = /(?:namespace|ns)[=:]\s*"?([a-z0-9][-a-z0-9.]{0,253})"?/i

function extractNamespace(event: LiveEvent): string | null {
  const m = NS_RE.exec(event.title) ?? NS_RE.exec(event.description)
  return m?.[1] ?? null
}

function isFiltered(event: LiveEvent, role: UserRole, scope: Scope): boolean {
  if (role === "cluster-admin") return false

  if (role === "viewer" || role === "guest") {
    if (event.type === "node") return true
    if (/secret/i.test(event.description)) return true
  }

  const ns = extractNamespace(event)
  if (ns === null) return false

  if (!scope.hasMapping) return true
  return !namespaceMatchesScope(ns, scope.namespaces)
}

function formatSSE(event: LiveEvent): string {
  return `id: ${event.id}\nevent: live\ndata: ${JSON.stringify(event)}\n\n`
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
  const scope = getVisibilityScope(groups, teams)
  const lastEventId = request.headers.get("Last-Event-ID") ?? null

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

      const fetchLimit = lastEventId ? MAX_EVENTS_REPLAY : DEFAULT_REPLAY
      const recent = await getRecentEvents(fetchLimit)
      // getRecentEvents returns newest-first; reverse to send oldest first.
      const ordered = recent.reverse()

      let replaySlice: LiveEvent[]
      if (lastEventId) {
        const idx = ordered.findIndex((e) => e.id === lastEventId)
        replaySlice = idx >= 0 ? ordered.slice(idx + 1) : ordered.slice(-DEFAULT_REPLAY)
      } else {
        replaySlice = ordered
      }

      for (const event of replaySlice) {
        if (!isFiltered(event, role, scope)) {
          enqueue(formatSSE(event))
        }
      }

      const heartbeatTimer = setInterval(() => {
        enqueue(": heartbeat\n\n")
      }, HEARTBEAT_MS)

      const abortHandler = () => {
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
      request.signal.addEventListener("abort", abortHandler)

      try {
        for await (const event of subscribeLive()) {
          if (request.signal.aborted) break
          if (!isFiltered(event, role, scope)) {
            enqueue(formatSSE(event))
          }
        }
      } finally {
        clearInterval(heartbeatTimer)
        request.signal.removeEventListener("abort", abortHandler)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
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
