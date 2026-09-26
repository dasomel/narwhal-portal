import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import {
  probeHttpDependency,
  probeK8sDependency,
  probeValkeyDependency,
  type DependencyStatus,
} from "@/lib/dependency-health"

export const dynamic = "force-dynamic"

// Same bound as /api/health/status's diagnostics probes — cheap enough that an
// authenticated caller fanning this out doesn't tie up a request thread for long,
// short enough that a hung upstream can't stall the whole response.
const PROBE_TIMEOUT_MS = 1500

// portal#47 unified dependency health contract, GET-only (read-only probe surface).
//
// Unlike /api/health/status (cluster-admin only, because it's an operator diagnostics
// view with 8 fanned-out probes), this endpoint is meant for any authenticated caller —
// dashboards/widgets that need to know "is prometheus/argocd/etc currently healthy"
// without being cluster-admin. That widens the audience, so the response is redacted by
// role: every caller gets {dependency, state, observedAt, reason}, where `reason` is
// always a short code (never a hostname/URL/raw error message — see dependency-health.ts's
// `detail` field docs). Only cluster-admin also gets `detail`, matching the precedent
// /api/health/status already sets (hostnames are an admin-only diagnostics surface).
//
// Never cached: every call re-probes live. Caching a failure here would violate #47's
// "cache entries ... must not silently extend validity after upstream failure" AC, and the
// bounded timeouts above make live probing on every call affordable for this endpoint's
// probe set (6 dependencies, ~1.5s worst case each, run concurrently).
export async function GET() {
  const gate = await requireRole("cluster-admin", "developer", "viewer", "guest")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }

  const isAdmin = gate.session.user.role === "cluster-admin"

  const dependencies = await Promise.all([
    probeHttpDependency("prometheus", process.env.PROMETHEUS_URL, { timeoutMs: PROBE_TIMEOUT_MS }),
    probeK8sDependency({ timeoutMs: PROBE_TIMEOUT_MS }),
    probeHttpDependency("argocd", process.env.ARGOCD_URL, { timeoutMs: PROBE_TIMEOUT_MS }),
    probeHttpDependency("gitea", process.env.GITEA_URL, { timeoutMs: PROBE_TIMEOUT_MS }),
    probeHttpDependency("keycloak", process.env.KEYCLOAK_ISSUER, { timeoutMs: PROBE_TIMEOUT_MS }),
    probeValkeyDependency({ timeoutMs: PROBE_TIMEOUT_MS }),
  ])

  return NextResponse.json({
    observedAt: new Date().toISOString(),
    dependencies: dependencies.map((d) => redactForRole(d, isAdmin)),
  })
}

// Strips the hostname-bearing `detail` field for anyone below cluster-admin. `reason` is
// already a coded token (e.g. "timeout", "http_503", "unconfigured") produced by
// dependency-health.ts's probes and is safe for every authenticated role.
function redactForRole(status: DependencyStatus, isAdmin: boolean): DependencyStatus {
  if (isAdmin) return status
  const { detail: _detail, ...rest } = status
  return rest
}
