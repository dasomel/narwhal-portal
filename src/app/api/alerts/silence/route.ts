import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { createSilence, deleteSilence, getSilence } from "@/lib/alertmanager"

export const dynamic = "force-dynamic"

// H-7: hard-cap silence duration. Defaults to 24h; override via env.
const MAX_SILENCE_HOURS = (() => {
  const raw = Number(process.env.ALERT_SILENCE_MAX_HOURS ?? "24")
  return Number.isFinite(raw) && raw > 0 ? raw : 24
})()
const MAX_SILENCE_MINUTES = MAX_SILENCE_HOURS * 60

const MATCHER_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const MAX_MATCHER_VALUE_LEN = 256
const MAX_COMMENT_LEN = 500

interface MatcherInput {
  name: string
  value: string
  isRegex: boolean
}

function validationError(message: string, field: string) {
  return NextResponse.json({ error: "ValidationError", message, field }, { status: 400 })
}

function validateMatchers(input: unknown): MatcherInput[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  if (input.length > 16) return null
  const out: MatcherInput[] = []
  for (const m of input) {
    if (!m || typeof m !== "object") return null
    const cast = m as { name?: unknown; value?: unknown; isRegex?: unknown }
    if (typeof cast.name !== "string" || !MATCHER_NAME_RE.test(cast.name)) return null
    if (typeof cast.value !== "string" || cast.value.length === 0 || cast.value.length > MAX_MATCHER_VALUE_LEN) return null
    out.push({
      name: cast.name,
      value: cast.value,
      isRegex: typeof cast.isRegex === "boolean" ? cast.isRegex : false,
    })
  }
  return out
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return validationError("body must be a JSON object", "body")
  }
  const raw = body as { alertname?: unknown; matchers?: unknown; duration?: unknown; comment?: unknown }

  let matchers: MatcherInput[] | null = null
  if (raw.matchers !== undefined) {
    matchers = validateMatchers(raw.matchers)
    if (!matchers) return validationError("invalid matchers", "matchers")
  } else if (typeof raw.alertname === "string" && raw.alertname.length > 0) {
    if (raw.alertname.length > MAX_MATCHER_VALUE_LEN) {
      return validationError("alertname too long", "alertname")
    }
    matchers = [{ name: "alertname", value: raw.alertname, isRegex: false }]
  } else {
    return validationError("missing matchers or alertname", "matchers")
  }

  const duration = typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : 60
  if (duration <= 0) return validationError("duration must be > 0", "duration")
  if (duration > MAX_SILENCE_MINUTES) {
    return validationError(`duration exceeds max ${MAX_SILENCE_HOURS}h`, "duration")
  }

  const comment = typeof raw.comment === "string" ? raw.comment.trim() : ""
  if (comment.length === 0) return validationError("comment required", "comment")
  if (comment.length > MAX_COMMENT_LEN) {
    return validationError(`comment too long (>${MAX_COMMENT_LEN})`, "comment")
  }

  const createdBy = session.user.email ?? session.user.name ?? "unknown"
  const silenceId = await createSilence(matchers, duration, createdBy, comment)
  if (!silenceId) return NextResponse.json({ error: "Failed to create silence" }, { status: 500 })

  console.info("[audit] alert-silence-create", {
    actor: createdBy,
    role: session.user.role,
    silenceId,
    matchers: matchers.map((m) => `${m.name}=${m.value}`),
    durationMinutes: duration,
    at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true, silenceId })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const silenceId = searchParams.get("id")
  if (!silenceId) return validationError("id required", "id")

  // H-7: ownership check — only cluster-admin or the original creator may delete.
  if (session.user.role !== "cluster-admin") {
    const existing = await getSilence(silenceId)
    if (!existing) return NextResponse.json({ error: "Silence not found" }, { status: 404 })
    const me = session.user.email ?? session.user.name ?? "unknown"
    if (existing.createdBy !== me) {
      return NextResponse.json({ error: "Forbidden: not silence owner" }, { status: 403 })
    }
  }

  const ok = await deleteSilence(silenceId)
  if (!ok) return NextResponse.json({ error: "Failed to delete silence" }, { status: 500 })

  console.info("[audit] alert-silence-delete", {
    actor: session.user.email ?? session.user.name ?? "unknown",
    role: session.user.role,
    silenceId,
    at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true })
}
