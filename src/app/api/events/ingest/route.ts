import { NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { pushEvent } from "@/lib/live-stream"
import { assertHttpUrl, ValidationError } from "@/lib/validation"
import { claimIdempotencyKey, getIdempotencyStore } from "@/lib/idempotency"
import { auth } from "@/lib/auth"
import {
  authenticateProducer,
  getRateLimiter,
  recordIngestOutcome,
  getIngestMetrics,
  MAX_INGEST_BODY_SIZE_BYTES,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_LINKS_COUNT,
  MAX_TOTAL_LINKS_SIZE_BYTES,
  MAX_IDENTIFIER_LENGTH,
  KNOWN_PRODUCERS,
} from "@/lib/event-ingest"
import { isValidEventActor, isValidEventResource } from "@/types/event-envelope"
import type { EventActor, EventResource } from "@/types/event-envelope"
import type { LiveEventIngest, LiveEventType, LiveEventVisibility, LiveSeverity, LiveSource } from "@/types/live"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_TYPES: LiveEventType[] = ["alert", "deploy", "sync", "node", "operation", "custom"]
const VALID_SEVERITIES: LiveSeverity[] = ["info", "success", "warning", "error"]
const VALID_SOURCES: LiveSource[] = KNOWN_PRODUCERS
const VALID_VISIBILITY: LiveEventVisibility[] = ["system", "cluster", "namespace", "team"]

// H-5: ingest-link host allowlist. Defaults cover the in-cluster infra hosts
// used by Alertmanager/ArgoCD; extend via env var.
const DEFAULT_LINK_HOSTS = [
  "argocd.narwhal.local",
  "alertmanager.narwhal.local",
  "prometheus.narwhal.local",
  "grafana.narwhal.local",
  "narwhal.local",
]
const LINK_HOST_ALLOWLIST = (process.env.LIVE_INGEST_LINK_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
const ALLOWED_LINK_HOSTS = LINK_HOST_ALLOWLIST.length > 0 ? LINK_HOST_ALLOWLIST : DEFAULT_LINK_HOSTS

export async function POST(request: Request) {
  // 1. Content-Length pre-check
  const contentLength = request.headers.get("content-length")
  if (contentLength && parseInt(contentLength, 10) > MAX_INGEST_BODY_SIZE_BYTES) {
    recordIngestOutcome("rejected", "unknown")
    return NextResponse.json(
      { error: "Payload Too Large", message: `Request body exceeds ${MAX_INGEST_BODY_SIZE_BYTES} bytes limit` },
      { status: 413 },
    )
  }

  // 2. Read body text with size enforcement
  let rawText: string
  try {
    rawText = await request.text()
  } catch {
    recordIngestOutcome("rejected", "unknown")
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  if (Buffer.byteLength(rawText, "utf8") > MAX_INGEST_BODY_SIZE_BYTES) {
    recordIngestOutcome("rejected", "unknown")
    return NextResponse.json(
      { error: "Payload Too Large", message: `Request body exceeds ${MAX_INGEST_BODY_SIZE_BYTES} bytes limit` },
      { status: 413 },
    )
  }

  // 3. Parse JSON
  let body: unknown
  try {
    body = JSON.parse(rawText)
  } catch {
    recordIngestOutcome("rejected", "unknown")
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    recordIngestOutcome("rejected", "unknown")
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 })
  }

  const raw = body as Record<string, unknown>

  // 4. Authenticate producer with credential scope & zero-downtime rotation
  const providedSecret = request.headers.get("X-Ingest-Secret") ?? ""
  const headerProducer = request.headers.get("X-Producer-Id") ?? request.headers.get("X-Ingest-Producer")
  const bodySource = typeof raw.source === "string" ? raw.source : null

  if (headerProducer && bodySource && headerProducer !== bodySource) {
    recordIngestOutcome("rejected", headerProducer)
    return NextResponse.json(
      { error: "Forbidden", message: "Producer identity mismatch between header and body" },
      { status: 403 },
    )
  }

  const producerHint = headerProducer || bodySource
  const authResult = authenticateProducer(providedSecret, producerHint)
  if (!authResult.authenticated) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json({ error: "Unauthorized", message: authResult.error }, { status: 401 })
  }

  // 5. Rate limiting per producer + IP
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1"
  const rateLimitKey = `${authResult.producer}:${ip}`
  const limiter = getRateLimiter()
  const rateResult = limiter.consume(rateLimitKey)
  if (!rateResult.allowed) {
    recordIngestOutcome("rate_limited", authResult.producer)
    return NextResponse.json(
      { error: "Too Many Requests", message: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateResult.retryAfterSeconds ?? 1),
          "X-RateLimit-Limit": String(rateResult.limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    )
  }

  // 6. Required field validation
  const missingFields: string[] = []
  for (const field of ["type", "severity", "title", "source"] as const) {
    if (!raw[field]) missingFields.push(field)
  }
  if (missingFields.length > 0) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      { error: `Missing required fields: ${missingFields.join(", ")}` },
      { status: 400 },
    )
  }

  if (!VALID_TYPES.includes(raw.type as LiveEventType)) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
      { status: 400 },
    )
  }
  if (!VALID_SEVERITIES.includes(raw.severity as LiveSeverity)) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      { error: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(", ")}` },
      { status: 400 },
    )
  }
  if (!VALID_SOURCES.includes(raw.source as LiveSource)) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}` },
      { status: 400 },
    )
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json({ error: "title must be a non-empty string" }, { status: 400 })
  }
  if (raw.title.length > MAX_TITLE_LENGTH) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      { error: "ValidationError", message: `title must not exceed ${MAX_TITLE_LENGTH} characters`, field: "title" },
      { status: 400 },
    )
  }

  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string" || raw.description.length > MAX_DESCRIPTION_LENGTH) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: `description must be a string ≤${MAX_DESCRIPTION_LENGTH} characters`,
          field: "description",
        },
        { status: 400 },
      )
    }
  }

  // 7. Canonical-envelope fields
  let resource: EventResource | null | undefined
  if (raw.resource !== undefined) {
    if (raw.resource !== null && !isValidEventResource(raw.resource)) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: "resource must be an object with optional string fields cluster/namespace/kind/name/workload",
          field: "resource",
        },
        { status: 400 },
      )
    }
    resource = raw.resource as EventResource | null
  }

  let actor: EventActor | null | undefined
  if (raw.actor !== undefined) {
    if (raw.actor !== null && !isValidEventActor(raw.actor)) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: "actor must be { id: string, type: 'user'|'system'|'service', displayName?: string }",
          field: "actor",
        },
        { status: 400 },
      )
    }
    actor = raw.actor as EventActor | null
  }

  let visibility: LiveEventVisibility | undefined
  if (raw.visibility !== undefined) {
    if (!VALID_VISIBILITY.includes(raw.visibility as LiveEventVisibility)) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: `visibility must be one of: ${VALID_VISIBILITY.join(", ")}`,
          field: "visibility",
        },
        { status: 400 },
      )
    }
    visibility = raw.visibility as LiveEventVisibility
  }

  const OPTIONAL_STRING_FIELDS = [
    "correlation_id",
    "causation_id",
    "operation_id",
    "idempotency_key",
    "source_event_id",
  ] as const
  const optionalStrings: Partial<Record<(typeof OPTIONAL_STRING_FIELDS)[number], string>> = {}
  for (const field of OPTIONAL_STRING_FIELDS) {
    const v = raw[field]
    if (v === undefined || v === null) continue
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_IDENTIFIER_LENGTH) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: `${field} must be a non-empty string ≤${MAX_IDENTIFIER_LENGTH} chars when provided`,
          field,
        },
        { status: 400 },
      )
    }
    optionalStrings[field] = v
  }

  // 8. Deduplication key requirement: must provide either idempotency_key or source_event_id
  if (!optionalStrings.idempotency_key && !optionalStrings.source_event_id) {
    recordIngestOutcome("rejected", authResult.producer)
    return NextResponse.json(
      {
        error: "ValidationError",
        message: "Ingest requires either idempotency_key or source_event_id for deduplication",
        field: "idempotency_key",
      },
      { status: 400 },
    )
  }

  // 9. Links validation & bounds
  let validatedLinks: { label: string; href: string }[] | undefined
  if (Array.isArray(raw.links)) {
    if (raw.links.length > MAX_LINKS_COUNT) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: `links array must not exceed ${MAX_LINKS_COUNT} items`,
          field: "links",
        },
        { status: 400 },
      )
    }

    let totalLinksSize = 0
    validatedLinks = []
    for (const link of raw.links as unknown[]) {
      if (!link || typeof link !== "object") continue
      const l = link as { label?: unknown; href?: unknown }
      if (typeof l.label !== "string" || l.label.length === 0 || l.label.length > 200) {
        recordIngestOutcome("rejected", authResult.producer)
        return NextResponse.json(
          { error: "ValidationError", message: "link.label must be a non-empty string ≤200 chars", field: "links" },
          { status: 400 },
        )
      }
      try {
        assertHttpUrl(l.href, ALLOWED_LINK_HOSTS, "link.href")
      } catch (err) {
        recordIngestOutcome("rejected", authResult.producer)
        if (err instanceof ValidationError) {
          return NextResponse.json(
            { error: "ValidationError", message: err.message, field: err.field },
            { status: 400 },
          )
        }
        throw err
      }
      const hrefStr = l.href as string
      totalLinksSize += l.label.length + hrefStr.length
      validatedLinks.push({ label: l.label, href: hrefStr })
    }

    if (totalLinksSize > MAX_TOTAL_LINKS_SIZE_BYTES) {
      recordIngestOutcome("rejected", authResult.producer)
      return NextResponse.json(
        {
          error: "ValidationError",
          message: `total links payload size must not exceed ${MAX_TOTAL_LINKS_SIZE_BYTES} bytes`,
          field: "links",
        },
        { status: 400 },
      )
    }
  }

  const source = raw.source as LiveSource

  // 10. Idempotency deduplication before persistence/fan-out
  const idempotencyKey = optionalStrings.idempotency_key
    ? `idempotency:${source}:${optionalStrings.idempotency_key}`
    : `source-event:${source}:${optionalStrings.source_event_id}`

  const eventId = randomUUID()
  const existing = await claimIdempotencyKey(getIdempotencyStore(), idempotencyKey, eventId)
  if (existing) {
    recordIngestOutcome("duplicate", authResult.producer)
    return NextResponse.json({
      ok: true,
      id: existing,
      duplicate: true,
      producer: authResult.producer,
    })
  }

  // 11. Fan-out event
  const ingest: LiveEventIngest = {
    id: eventId,
    type: raw.type as LiveEventType,
    severity: raw.severity as LiveSeverity,
    title: raw.title as string,
    description: typeof raw.description === "string" ? raw.description : "",
    source,
    producer: authResult.producer,
    credential_scope: authResult.credentialScope,
    links: validatedLinks,
    resource,
    actor,
    visibility,
    correlation_id: optionalStrings.correlation_id,
    causation_id: optionalStrings.causation_id,
    operation_id: optionalStrings.operation_id,
    idempotency_key: optionalStrings.idempotency_key,
    source_event_id: optionalStrings.source_event_id,
  }

  try {
    const event = await pushEvent(ingest)
    recordIngestOutcome("accepted", authResult.producer)
    return NextResponse.json({
      ok: true,
      id: event.id,
      producer: authResult.producer,
      credential_scope: authResult.credentialScope,
    })
  } catch (err) {
    recordIngestOutcome("rejected", authResult.producer)
    console.error("[api/events/ingest] Push event failed:", err instanceof Error ? err.message : "unknown")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * Diagnostics & metrics endpoint for ingest monitoring.
 * Authenticated via session or ingest secret.
 */
export async function GET(request: Request) {
  const session = await auth()
  const providedSecret = request.headers.get("X-Ingest-Secret") ?? ""
  const authRes = providedSecret ? authenticateProducer(providedSecret) : null

  if (!session && (!authRes || !authRes.authenticated)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return NextResponse.json(getIngestMetrics())
}
