import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { getDependencyHealthSnapshot } from "@/lib/dependency-health"

export const dynamic = "force-dynamic"

// Same bound as /api/health/status's diagnostics probes — cheap enough that a fan-out doesn't
// tie up a request thread for long, short enough that a hung upstream can't stall the response.
const PROBE_TIMEOUT_MS = 1500

// portal#47 unified dependency health contract, GET-only (read-only probe surface).
//
// cluster-admin only, matching /api/health/status's precedent exactly: this fans out up to 6
// outbound probes per uncached call and its `detail` field carries a redacted-but-still-a-
// hostname diagnostic (see dependency-health.ts's DependencyStatus docs) — the same
// "amplification vector / dependency topology leak to an unprivileged caller" concern that
// keeps /api/health/status admin-gated applies here too. A future non-admin-facing aggregate
// (e.g. a single boolean "any core dependency degraded") is a separate, later slice — not
// built here.
//
// getDependencyHealthSnapshot() (dependency-health.ts) owns coalescing (concurrent callers
// during a run share one fan-out) and short-TTL caching (a clean "all ok" snapshot only —
// never a run with any partial/stale/unavailable/unauthorized dependency), so this route body
// stays a thin gate + passthrough.
export async function GET() {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  const snapshot = await getDependencyHealthSnapshot({ timeoutMs: PROBE_TIMEOUT_MS })

  return NextResponse.json(snapshot)
}
