import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

const TEMPO_URL = process.env.TEMPO_URL ?? "http://localhost:3200"

// M-3: TraceQL service-name parameter — DNS-style label characters only.
// Rejects quotes, braces, semicolons → no template breakout.
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export interface TraceEntry {
  traceID: string
  serviceName: string
  operationName: string
  duration: number
  startTime: number
  spanCount: number
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const service = searchParams.get("service") ?? ""
  if (service && !SERVICE_NAME_RE.test(service)) {
    return NextResponse.json(
      { error: "ValidationError", message: "invalid service name", field: "service" },
      { status: 400 },
    )
  }

  const cacheKey = `traces:${service}`
  const cached = await cacheGet<TraceEntry[]>(cacheKey)
  if (cached) return NextResponse.json(cached)

  try {
    const query = service ? `{resource.service.name="${service}"}` : "{}"
    const res = await fetch(
      `${TEMPO_URL}/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return NextResponse.json([])

    const data = await res.json()
    const traces: TraceEntry[] = (data.traces ?? []).map((t: { traceID: string; rootServiceName: string; rootTraceName: string; durationMs: number; startTimeUnixNano: string; spanSets?: Array<{ spans: unknown[] }> }) => ({
      traceID: t.traceID,
      serviceName: t.rootServiceName ?? "",
      operationName: t.rootTraceName ?? "",
      duration: t.durationMs ?? 0,
      startTime: Math.floor(Number(t.startTimeUnixNano) / 1000000),
      spanCount: t.spanSets?.[0]?.spans?.length ?? 0,
    }))

    await cacheSet(cacheKey, traces, 15)
    return NextResponse.json(traces)
  } catch {
    return NextResponse.json([])
  }
}
