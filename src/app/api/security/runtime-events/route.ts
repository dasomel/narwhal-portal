import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getRuntimeEvents } from "@/lib/falco"
import type { FalcoEventPriority } from "@/types/security"

export const dynamic = "force-dynamic"

const VALID_PRIORITIES: FalcoEventPriority[] = [
  "Emergency",
  "Alert",
  "Critical",
  "Error",
  "Warning",
  "Notice",
  "Informational",
  "Debug",
]

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  try {
    const { searchParams } = new URL(req.url)
    const priorityParam = searchParams.get("priority")
    const sinceMinutesParam = searchParams.get("sinceMinutes")
    const limitParam = searchParams.get("limit")

    if (priorityParam && !VALID_PRIORITIES.includes(priorityParam as FalcoEventPriority)) {
      return NextResponse.json({ error: "Invalid priority value" }, { status: 400 })
    }

    const sinceMinutes = sinceMinutesParam ? parseInt(sinceMinutesParam, 10) : undefined
    const limit = limitParam ? parseInt(limitParam, 10) : undefined

    if (sinceMinutes !== undefined && (isNaN(sinceMinutes) || sinceMinutes <= 0)) {
      return NextResponse.json({ error: "sinceMinutes must be a positive integer" }, { status: 400 })
    }
    if (limit !== undefined && (isNaN(limit) || limit <= 0)) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 })
    }

    const events = await getRuntimeEvents({
      priority: priorityParam ? (priorityParam as FalcoEventPriority) : undefined,
      sinceMinutes,
      limit,
    })

    return NextResponse.json(events)
  } catch (err) {
    console.error("GET /api/security/runtime-events error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
