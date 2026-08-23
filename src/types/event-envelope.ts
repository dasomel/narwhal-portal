/**
 * Canonical Event Envelope — portal#11.
 *
 * The full contract every internally-produced event (operation lifecycle,
 * ingested webhook, K8s informer) can be normalized into: correlation/causation
 * chaining, idempotency, and a structured `resource` instead of parsing one out
 * of free-text title/description.
 *
 * `LiveEvent` (src/types/live.ts) stays the dashboard-facing, backward-compatible
 * type — it now carries an optional subset of these fields (resource, actor,
 * operation_id, correlation_id, causation_id, idempotency_key, source_event_id,
 * event_type) so existing consumers that only read id/type/severity/... keep
 * working unchanged, while envelope-aware producers/consumers (operation-context,
 * the ingest route, the SSE stream's namespace filter) get the structured data.
 */

export type EventEnvelopeSchemaVersion = "1.0"

export const EVENT_ENVELOPE_SCHEMA_VERSION: EventEnvelopeSchemaVersion = "1.0"

export type EventActorType = "user" | "system" | "service"

export interface EventActor {
  /** Stable identity — session email/subject for users, a fixed string for system/service actors. */
  id: string
  type: EventActorType
  displayName?: string
}

export interface EventResource {
  cluster?: string
  namespace?: string
  kind?: string
  name?: string
  workload?: string
}

export interface EventEnvelope<TData = Record<string, unknown>> {
  event_id: string
  event_type: string
  event_version: string
  schema_version: EventEnvelopeSchemaVersion
  occurred_at: string
  received_at: string
  correlation_id: string
  causation_id: string | null
  request_id: string | null
  operation_id: string | null
  incident_id: string | null
  evidence_id: string | null
  trace_id: string | null
  span_id: string | null
  source: string
  source_version: string | null
  actor: EventActor
  resource: EventResource | null
  idempotency_key: string | null
  source_event_id: string | null
  data: TData
}

/** Shape check for an inbound `actor` field — required keys only when the field is present at all. */
export function isValidEventActor(v: unknown): v is EventActor {
  if (!v || typeof v !== "object") return false
  const a = v as Record<string, unknown>
  if (typeof a.id !== "string" || a.id.length === 0) return false
  if (a.type !== "user" && a.type !== "system" && a.type !== "service") return false
  if (a.displayName !== undefined && typeof a.displayName !== "string") return false
  return true
}

/** Shape check for an inbound `resource` field — every key is optional but must be a string when present. */
export function isValidEventResource(v: unknown): v is EventResource {
  if (!v || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  const keys = ["cluster", "namespace", "kind", "name", "workload"] as const
  return keys.every((k) => r[k] === undefined || typeof r[k] === "string")
}
