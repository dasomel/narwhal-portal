import { NextResponse } from "next/server"
import { randomUUID, timingSafeEqual } from "crypto"
import { pushEvent } from "@/lib/live-stream"
import { assertHttpUrl, ValidationError } from "@/lib/validation"
import { claimIdempotencyKey, getIdempotencyStore } from "@/lib/idempotency"
import { isValidEventActor, isValidEventResource } from "@/types/event-envelope"
import type { EventActor, EventResource } from "@/types/event-envelope"
import type { LiveEventIngest, LiveEventType, LiveEventVisibility, LiveSeverity, LiveSource } from "@/types/live"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_TYPES: LiveEventType[] = ["alert", "deploy", "sync", "node", "custom"]
const VALID_SEVERITIES: LiveSeverity[] = ["info", "success", "warning", "error"]
const VALID_SOURCES: LiveSource[] = ["alertmanager", "argocd", "kubernetes", "manual"]
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

/**
 * H-5: Constant-time comparison to defeat timing oracles. Mismatched lengths
 * still pay one comparison against a same-length dummy buffer.
 */
function safeSecretCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Constant-work no-op to mask length mismatch in timing.
    timingSafeEqual(a, Buffer.alloc(a.length))
    return false
  }
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const secret = process.env.LIVE_INGEST_SECRET
  const provided = request.headers.get("X-Ingest-Secret") ?? ""

  if (!secret || !safeSecretCompare(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 })
  }

  const raw = body as Record<string, unknown>

  // Required field validation
  const missingFields: string[] = []
  for (const field of ["type", "severity", "title", "source"] as const) {
    if (!raw[field]) missingFields.push(field)
  }
  if (missingFields.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missingFields.join(", ")}` },
      { status: 400 }
    )
  }

  if (!VALID_TYPES.includes(raw.type as LiveEventType)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    )
  }
  if (!VALID_SEVERITIES.includes(raw.severity as LiveSeverity)) {
    return NextResponse.json(
      { error: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(", ")}` },
      { status: 400 }
    )
  }
  if (!VALID_SOURCES.includes(raw.source as LiveSource)) {
    return NextResponse.json(
      { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}` },
      { status: 400 }
    )
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return NextResponse.json({ error: "title must be a non-empty string" }, { status: 400 })
  }

  // Canonical-envelope fields (portal#11): optional so legacy producers (K8s
  // informer, ad-hoc webhook callers) keep working unchanged, but validated when
  // present.
  let resource: EventResource | null | undefined
  if (raw.resource !== undefined) {
    if (raw.resource !== null && !isValidEventResource(raw.resource)) {
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

  // portal#12: explicit visibility, required to see a non-admin viewer when
  // resource.namespace is absent — an unset value now default-denies at the SSE
  // route rather than being implicitly public.
  let visibility: LiveEventVisibility | undefined
  if (raw.visibility !== undefined) {
    if (!VALID_VISIBILITY.includes(raw.visibility as LiveEventVisibility)) {
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
    if (v === undefined) continue
    if (typeof v !== "string" || v.length === 0) {
      return NextResponse.json(
        { error: "ValidationError", message: `${field} must be a non-empty string when provided`, field },
        { status: 400 },
      )
    }
    optionalStrings[field] = v
  }

  // H-5: validate link.href against http(s) + host allowlist.
  let validatedLinks: { label: string; href: string }[] | undefined
  if (Array.isArray(raw.links)) {
    validatedLinks = []
    for (const link of raw.links as unknown[]) {
      if (!link || typeof link !== "object") continue
      const l = link as { label?: unknown; href?: unknown }
      if (typeof l.label !== "string" || l.label.length === 0 || l.label.length > 200) {
        return NextResponse.json(
          { error: "ValidationError", message: "link.label must be a non-empty string ≤200 chars", field: "links" },
          { status: 400 },
        )
      }
      try {
        assertHttpUrl(l.href, ALLOWED_LINK_HOSTS, "link.href")
      } catch (err) {
        if (err instanceof ValidationError) {
          return NextResponse.json(
            { error: "ValidationError", message: err.message, field: err.field },
            { status: 400 },
          )
        }
        throw err
      }
      validatedLinks.push({ label: l.label, href: l.href as string })
    }
  }

  const source = raw.source as LiveSource

  // Idempotency (portal#11): dedupe on the producer-supplied idempotency_key, or
  // on source_event_id namespaced by source (a producer's own event id is only
  // unique within that producer). A duplicate retry short-circuits to the id of
  // the event that won the original claim instead of pushing a second event.
  const idempotencyKey =
    optionalStrings.idempotency_key ??
    (optionalStrings.source_event_id ? `source-event:${source}:${optionalStrings.source_event_id}` : undefined)

  const eventId = randomUUID()
  if (idempotencyKey) {
    const existing = await claimIdempotencyKey(getIdempotencyStore(), idempotencyKey, eventId)
    if (existing) {
      return NextResponse.json({ ok: true, id: existing, duplicate: true })
    }
  }

  const ingest: LiveEventIngest = {
    // Only pin the id when it's the value we just claimed the idempotency key
    // with — otherwise let pushEvent mint one, same as before this change.
    id: idempotencyKey ? eventId : undefined,
    type: raw.type as LiveEventType,
    severity: raw.severity as LiveSeverity,
    title: raw.title as string,
    description: typeof raw.description === "string" ? raw.description : "",
    source,
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
    return NextResponse.json({ ok: true, id: event.id })
  } catch (err) {
    console.error("[api/events/ingest]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
