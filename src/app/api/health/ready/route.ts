import { NextResponse } from "next/server"
import { validateRuntimeConfig, IS_PRODUCTION } from "@/lib/config"
import { getValkeyClient } from "@/lib/valkey"

export const dynamic = "force-dynamic"

// Readiness probe: verifies essential configuration and critical dependencies.
// Returns HTTP 200 when ready to serve traffic, HTTP 503 when not ready.
export async function GET() {
  const config = validateRuntimeConfig()

  if (!config.valid) {
    return NextResponse.json(
      {
        status: "not_ready",
        reason: "Missing required configuration",
        missing: config.missingRequired,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    )
  }

  // Quick bounded ping to Valkey if configured
  let valkeyStatus: "ok" | "degraded" | "skipped" = "skipped"
  if (process.env.VALKEY_URL || process.env.VALKEY_PASSWORD) {
    try {
      const client = getValkeyClient()
      const pingRes = await Promise.race([
        client.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Valkey ping timeout")), 2000)
        ),
      ])
      valkeyStatus = pingRes === "PONG" ? "ok" : "degraded"
    } catch {
      valkeyStatus = "degraded"
    }
  }

  // In production without mock auth, fail readiness if valkey is down
  if (IS_PRODUCTION && process.env.AUTH_MOCK !== "true" && valkeyStatus === "degraded") {
    return NextResponse.json(
      {
        status: "not_ready",
        reason: "Critical cache dependency unavailable",
        checks: {
          config: "ok",
          valkey: "degraded",
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    )
  }

  return NextResponse.json({
    status: "ready",
    checks: {
      config: "ok",
      valkey: valkeyStatus,
    },
    environment: config.environment,
    timestamp: new Date().toISOString(),
  })
}
