import "server-only"
import { cacheGet, cacheSet } from "./valkey"
import { assertLogQLSafe } from "./validation"
import type { FalcoEvent, FalcoEventPriority } from "@/types/security"

const LOKI_URL = process.env.LOKI_URL ?? "http://loki.monitoring.svc.cluster.local:3100"

// FalcoEventPriority is Capitalized; Loki label values from Falcosidekick are lowercase
function toLokiPriority(p: FalcoEventPriority): string {
  return p.toLowerCase()
}

function capitalizeFirst(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

// Falco JSON line shape (Falco JSON output enabled via falco.json_output: true)
interface FalcoJsonLine {
  output?: string
  priority?: string
  rule?: string
  time?: string
  source?: string
  output_fields?: Record<string, string | undefined>
  hostname?: string
  tags?: string[]
}

// Loki query_range response shape
interface LokiStream {
  stream: Record<string, string>
  values: [string, string][] // [ts_nanoseconds, log_line]
}

interface LokiQueryResponse {
  status: string
  data: {
    resultType: string
    result: LokiStream[]
  }
}

function parseFalcoEvent(tsNano: string, line: string, streamMeta: Record<string, string>): FalcoEvent | null {
  let parsed: FalcoJsonLine
  try {
    parsed = JSON.parse(line) as FalcoJsonLine
  } catch {
    return null
  }

  const hostname = parsed.hostname ?? streamMeta["hostname"] ?? "?"
  const id = `${hostname}-${tsNano}`
  const time = new Date(Math.floor(parseInt(tsNano, 10) / 1_000_000)).toISOString()
  const rawPriority = parsed.priority ?? streamMeta["priority"] ?? "informational"
  const priority = capitalizeFirst(rawPriority) as FalcoEventPriority

  return {
    id,
    time,
    priority,
    rule: parsed.rule ?? "",
    output: parsed.output ?? line,
    source: parsed.source ?? "syscall",
    tags: parsed.tags,
    pod: parsed.output_fields?.["k8s.pod.name"],
    namespace: parsed.output_fields?.["k8s.ns.name"],
    container: parsed.output_fields?.["container.name"],
    image: parsed.output_fields?.["container.image.repository"],
  }
}

async function queryLoki(logql: string, sinceMinutes: number, limit: number): Promise<FalcoEvent[]> {
  // M-2: LogQL safety — defense in depth (callers use templated queries).
  assertLogQLSafe(logql)
  const nowMs = Date.now()
  const startMs = nowMs - sinceMinutes * 60 * 1000
  // Loki expects nanosecond timestamps; multiply ms by 1_000_000 using string to avoid BigInt
  const nowNs = String(nowMs) + "000000"
  const startNs = String(startMs) + "000000"

  const params = new URLSearchParams({
    query: logql,
    start: startNs,
    end: nowNs,
    limit: String(limit),
    direction: "BACKWARD",
  })

  const url = `${LOKI_URL}/loki/api/v1/query_range?${params.toString()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
  if (!res.ok) {
    throw new Error(`Loki API ${res.status} ${res.statusText}`)
  }

  const body = (await res.json()) as LokiQueryResponse
  const events: FalcoEvent[] = []

  for (const stream of body.data?.result ?? []) {
    for (const [tsNano, line] of stream.values) {
      const event = parseFalcoEvent(tsNano, line, stream.stream)
      if (event) events.push(event)
    }
  }

  return events
}

interface GetRuntimeEventsOpts {
  priority?: FalcoEventPriority
  sinceMinutes?: number
  limit?: number
}

export async function getRuntimeEvents(opts: GetRuntimeEventsOpts = {}): Promise<FalcoEvent[]> {
  const { priority, sinceMinutes = 60, limit = 100 } = opts
  const cacheKey = `falco:events:${priority ?? "all"}:${sinceMinutes}:${limit}`
  const cached = await cacheGet<FalcoEvent[]>(cacheKey)
  if (cached) return cached

  try {
    // Falcosidekick `source` label = Falco event source (e.g. "syscall"), not literal "falco".
    // Use `rule` label presence as Falco-specific identifier (only Falcosidekick streams have it).
    const logql = priority
      ? `{rule=~".+", priority="${toLokiPriority(priority)}"}`
      : `{rule=~".+"}`

    const events = await queryLoki(logql, sinceMinutes, limit)

    await cacheSet(cacheKey, events, 30)
    return events
  } catch (err) {
    console.warn("[falco] getRuntimeEvents failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getCriticalRuntimeAlerts(): Promise<FalcoEvent[]> {
  const cacheKey = "falco:critical"
  const cached = await cacheGet<FalcoEvent[]>(cacheKey)
  if (cached) return cached

  try {
    // Use Loki with critical priority filter — Alertmanager only holds active alerts
    // and would require additional label mapping; Loki provides the full history with
    // the same priority label set by Falcosidekick.
    const events = await getRuntimeEvents({ priority: "Critical", limit: 50 })

    await cacheSet(cacheKey, events, 30)
    return events
  } catch (err) {
    console.warn("[falco] getCriticalRuntimeAlerts failed:", err instanceof Error ? err.message : err)
    return []
  }
}
