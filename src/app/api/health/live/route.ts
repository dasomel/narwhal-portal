import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

// Liveness probe: verifies process is alive and event loop is responding.
// Independent of external dependencies/database/SSO.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "narwhal-portal",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    pid: process.pid,
  })
}
