import type { EventActor, EventResource } from "./event-envelope"

export type LiveEventType = "alert" | "deploy" | "sync" | "node" | "operation" | "custom"
export type LiveSeverity = "info" | "success" | "warning" | "error"
export type LiveSource = "alertmanager" | "argocd" | "kubernetes" | "manual"

// Canonical-envelope fields (portal#11), optional so every existing producer/consumer
// of LiveEvent (K8s informer, ingest webhook, dashboard) keeps compiling and rendering
// unchanged. Envelope-aware producers (src/lib/operation-context.ts, an ingest request
// that supplies them) populate them; the SSE stream's namespace filter prefers
// `resource.namespace` over its legacy title/description regex when present.
interface EventEnvelopeFields {
  resource?: EventResource | null
  actor?: EventActor | null
  operation_id?: string | null
  correlation_id?: string | null
  causation_id?: string | null
  idempotency_key?: string | null
  source_event_id?: string | null
  // Fine-grained event type, e.g. "operation.started" — distinct from the coarse
  // `type` field used for dashboard filtering.
  event_type?: string | null
}

export interface LiveEvent extends EventEnvelopeFields {
  id: string // UUID
  type: LiveEventType
  severity: LiveSeverity
  timestamp: string // ISO8601
  title: string
  description: string
  source: LiveSource
  links: { label: string; href: string }[] | null
}

export interface LiveEventIngest extends EventEnvelopeFields {
  // Optional producer-supplied id — used by idempotent ingest so a claimed
  // idempotency key and the resulting event share the same id. Omitted, the
  // pipeline mints one.
  id?: string
  type: LiveEventType
  severity: LiveSeverity
  title: string
  description: string
  source: LiveSource
  links?: { label: string; href: string }[]
}
