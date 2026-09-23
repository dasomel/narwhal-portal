import { NextResponse } from "next/server"
import { validateRuntimeConfig } from "@/lib/config"
import { getValkey } from "@/lib/valkey"
import { requireRole } from "@/lib/auth"

export const dynamic = "force-dynamic"

// Bounded connectivity probe timeout. This endpoint is an operator diagnostics
// surface (not the readiness gate — see ready/route.ts), so it can afford one
// short round trip per dependency; still bounded so a hung upstream can't hang
// the whole response.
const PROBE_TIMEOUT_MS = 1500

type DependencyState = "healthy" | "degraded" | "unavailable" | "unconfigured"

interface DependencyCheck {
  required: boolean
  state: DependencyState
}

// Best-effort reachability check against the dependency's base URL. This only
// proves "something answered" — it does not validate the specific API surface
// the Portal needs (that requires per-provider protocol knowledge, tracked by
// #47). Sufficient for operator diagnostics; readiness does not use this.
async function probeHttpDependency(url: string | undefined): Promise<DependencyState> {
  if (!url) return "unconfigured"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal })
    return res.ok ? "healthy" : "degraded"
  } catch {
    return "unavailable"
  } finally {
    clearTimeout(timer)
  }
}

// Mirrors ready/route.ts's Valkey ping (same timeout/critical semantics) so the
// diagnostics view and the readiness gate never disagree about cache health.
async function probeValkey(): Promise<DependencyState> {
  if (!process.env.VALKEY_URL && !process.env.VALKEY_PASSWORD) return "unconfigured"
  try {
    const client = getValkey()
    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Valkey ping timeout")), PROBE_TIMEOUT_MS)),
    ])
    return pong === "PONG" ? "healthy" : "degraded"
  } catch {
    return "unavailable"
  }
}

// Detailed status/diagnostics endpoint for operators.
// Does not expose secret values, credentials, sensitive tokens, or raw dependency URLs.
//
// RBAC-gated (cluster-admin only), unlike /live and /ready: this route fans out up to
// 8 outbound probes per call, which an unauthenticated caller could use as both a
// request-amplification vector and a live map of which backend dependencies are down.
// /live and /ready stay open (see src/proxy.ts's matcher) because they do no comparable
// fan-out — /ready's only outbound call is a single bounded Valkey ping.
export async function GET() {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  const config = validateRuntimeConfig()

  const [keycloak, argocd, prometheus, alertmanager, gitea, openbao, loki, valkey] = await Promise.all([
    probeHttpDependency(process.env.KEYCLOAK_ISSUER),
    probeHttpDependency(process.env.ARGOCD_URL),
    probeHttpDependency(process.env.PROMETHEUS_URL),
    probeHttpDependency(process.env.ALERTMANAGER_URL),
    probeHttpDependency(process.env.GITEA_URL),
    probeHttpDependency(process.env.OPENBAO_ADDR),
    probeHttpDependency(process.env.LOKI_URL),
    probeValkey(),
  ])

  // required: true marks dependencies whose loss should be visible as degraded
  // overall status — Keycloak per validateRuntimeConfig()'s requiredInProd list,
  // Valkey per ready/route.ts's critical-cache gate. The rest are config.ts's
  // optionalServices: their degradation must not read as a platform-wide problem
  // (#63 acceptance criterion: optional dependency degradation must not
  // unnecessarily pull the replica out of service).
  const dependencies: Record<string, DependencyCheck> = {
    keycloak: { required: true, state: keycloak },
    valkey: { required: true, state: valkey },
    argocd: { required: false, state: argocd },
    prometheus: { required: false, state: prometheus },
    alertmanager: { required: false, state: alertmanager },
    gitea: { required: false, state: gitea },
    openbao: { required: false, state: openbao },
    loki: { required: false, state: loki },
  }

  const requiredDependencyDown = Object.values(dependencies).some(
    (d) => d.required && (d.state === "unavailable" || d.state === "degraded"),
  )

  return NextResponse.json({
    status: config.valid && !requiredDependencyDown ? "healthy" : "degraded",
    environment: config.environment,
    version: process.env.npm_package_version ?? "0.1.0",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    config: {
      valid: config.valid,
      missingRequired: config.missingRequired,
      missingOptional: config.missingOptional,
      details: config.details,
    },
    dependencies,
  })
}
