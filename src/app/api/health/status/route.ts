import { NextResponse } from "next/server"
import { validateRuntimeConfig } from "@/lib/config"

export const dynamic = "force-dynamic"

// Detailed status/diagnostics endpoint for operators.
// Does not expose secret values, credentials, or sensitive tokens.
export async function GET() {
  const config = validateRuntimeConfig()

  const dependencyHealth = {
    keycloak: process.env.KEYCLOAK_ISSUER ? "configured" : "unconfigured",
    argocd: process.env.ARGOCD_URL ? "configured" : "unconfigured",
    prometheus: process.env.PROMETHEUS_URL ? "configured" : "unconfigured",
    alertmanager: process.env.ALERTMANAGER_URL ? "configured" : "unconfigured",
    gitea: process.env.GITEA_URL ? "configured" : "unconfigured",
    openbao: process.env.OPENBAO_ADDR ? "configured" : "unconfigured",
    loki: process.env.LOKI_URL ? "configured" : "unconfigured",
    valkey: process.env.VALKEY_URL ? "configured" : "unconfigured",
  }

  return NextResponse.json({
    status: config.valid ? "healthy" : "degraded",
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
    dependencies: dependencyHealth,
  })
}
