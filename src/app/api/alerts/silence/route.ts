import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { createSilence, deleteSilence, getSilence } from "@/lib/alertmanager"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"
import { claimIdempotencyKey, fulfillIdempotencyKey, getIdempotencyStore } from "@/lib/idempotency"
import { checkSilenceScope, type SilenceMatcher } from "@/lib/alert-silence-scope"
import { getEffectiveScope } from "@/lib/scope"

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

function validationError(message: string, field: string) {
  return NextResponse.json({ error: "ValidationError", message, field }, { status: 400 })
}

function validateMatchers(input: unknown): SilenceMatcher[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  if (input.length > 16) return null
  const out: SilenceMatcher[] = []
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

  let matchers: SilenceMatcher[] | null = null
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

  const scope = await getEffectiveScope({ groups: session.groups ?? [], teams: session.teams ?? [] })
  const scopeVerdict = checkSilenceScope(matchers, session.user.role, scope)
  if (!scopeVerdict.ok) {
    const errorKind = scopeVerdict.status === 403 ? "Forbidden" : "ValidationError"
    return NextResponse.json({ error: errorKind, message: scopeVerdict.message }, { status: scopeVerdict.status })
  }

  // portal#34: dedupe a repeated create (double-click, client retry on a timeout)
  // against the exact same matcher set + duration + comment for the same actor.
  // Alertmanager mints the silence id, so unlike /api/events/ingest (which mints its
  // own id up front and claims with that) this is a claim-then-fulfill: claim a
  // placeholder tagged with a fingerprint of the request first, create the silence,
  // then overwrite the claim with the real id. A duplicate that lands while the
  // first request is still in flight (placeholder not yet fulfilled) falls through
  // and creates its own silence rather than blocking — an occasional double-create
  // under true concurrency is an acceptable tradeoff for not stalling the request.
  const createdBy = session.user.email ?? session.user.name ?? "unknown"
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
  const idempotencyStoreKey = idempotencyKey ? `alert-silence:${idempotencyKey}` : null
  if (idempotencyStoreKey) {
    const fingerprint = JSON.stringify({ createdBy, matchers, duration, comment })
    const claimed = await claimIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, `pending:${fingerprint}`)
    if (claimed !== null) {
      if (claimed.startsWith("pending:")) {
        if (claimed.slice("pending:".length) !== fingerprint) {
          return validationError("Idempotency-Key reused with a different request body", "Idempotency-Key")
        }
      } else {
        return NextResponse.json({ success: true, silenceId: claimed, duplicate: true })
      }
    }
  }

  const matcherSummary = matchers.map((m) => `${m.name}=${m.value}`).join(", ")
  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "alert.silence.create",
    source: "alertmanager",
    resource: {
      kind: "Silence",
      namespace: matchers.find((m) => m.name === "namespace")?.value,
      name: matcherSummary,
    },
    title: "Alert silence create started",
    description: `Matchers: ${matcherSummary}`,
  })

  const silenceId = await createSilence(matchers, duration, createdBy, comment)
  if (!silenceId) {
    await failOperation(ctx, "Alert silence create failed", "Alertmanager did not return a silence ID")
    return NextResponse.json({ error: "Failed to create silence" }, { status: 500 })
  }

  if (idempotencyStoreKey) {
    await fulfillIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, silenceId)
  }

  await completeOperation(
    ctx,
    `Alert silence created: ${silenceId}`,
    `Matchers: ${matcherSummary}; durationMinutes=${duration}`,
  )

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
  // Also the only path with a matchers list at hand, so it doubles as this
  // operation's resource.namespace source.
  let namespaceHint: string | undefined
  if (session.user.role !== "cluster-admin") {
    const existing = await getSilence(silenceId)
    if (!existing) return NextResponse.json({ error: "Silence not found" }, { status: 404 })
    const me = session.user.email ?? session.user.name ?? "unknown"
    if (existing.createdBy !== me) {
      return NextResponse.json({ error: "Forbidden: not silence owner" }, { status: 403 })
    }
    namespaceHint = existing.matchers.find((m) => m.name === "namespace")?.value
  }
  // cluster-admin path skips the ownership fetch above, so resource.namespace
  // stays undefined there rather than paying an extra Alertmanager round trip
  // this route doesn't otherwise need.

  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "alert.silence.delete",
    source: "alertmanager",
    resource: { kind: "Silence", namespace: namespaceHint, name: silenceId },
    title: `Alert silence delete started: ${silenceId}`,
  })

  const ok = await deleteSilence(silenceId)
  if (!ok) {
    await failOperation(ctx, `Alert silence delete failed: ${silenceId}`)
    return NextResponse.json({ error: "Failed to delete silence" }, { status: 500 })
  }

  await completeOperation(ctx, `Alert silence deleted: ${silenceId}`)

  return NextResponse.json({ success: true })
}
