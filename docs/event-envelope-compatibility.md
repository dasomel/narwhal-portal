# Event Envelope Schema Compatibility Matrix & Rolling Upgrade Contract

> Scope Note: Documents the current envelope contract and provides characterization tests for existing behavior (portal#11, portal#12). Fail-closed version enforcement, skew windows, and replay translation are not yet implemented; defining supported versions and upgrade skew remains an open maintainer decision. Narwhal cluster-side producer contracts remain undefined (`narwhal#140` unstarted).

## Status against #38 Acceptance Criteria

This document and associated test suite characterize the current codebase as implemented. They document existing wire contracts and characterize observed behavior, rather than claiming implementation of criteria that require maintainer policy decisions:

- **Documented & Tested (Current Contract Characterization)**:
  - Canonical envelope schema structure and field definitions ([Section 1](#1-schema-version-fields-as-implemented)).
  - Producer and consumer format matrix across Portal subsystems ([Section 2](#2-producer--consumer-version--format-matrix)).
  - Forward compatibility: unrecognized top-level fields dropped during ingest, while permissive sub-object validators (`actor`, `resource`) accept unknown properties ([Section 3.1](#31-unknown-fields-forward-compatibility)).
  - Backward compatibility: older/minimal shapes omitting optional envelope fields normalize cleanly to `null` and deserialize safely during replay ([Section 3.2](#32-missing-optional-fields-backward-compatibility)).
  - Legacy header alias: `X-Ingest-Producer` supported alongside canonical `X-Producer-Id` ([Section 2](#2-producer--consumer-version--format-matrix)).
  - Fail-open characterization: characterization tests verify that unsupported `schema_version` is currently accepted at ingest and during replay pending a fail-closed policy decision ([Section 3.4](#34-unknown-versions-observed-code-behavior)).
- **Open Pending Maintainer Decision**:
  - **Supported Version Set**: Formal declaration of supported `schema_version` and `event_version` combinations.
  - **Defined Skew Window**: Specification of allowable version skew across rolling pod upgrades.
  - **Fail-Closed Policy with Diagnostics**: Rejecting unsupported or unknown `schema_version` with HTTP 4xx and diagnostic error details (current code is fail-open).
  - **Replay Translation Layer**: Transforming or up-casting older historical event shapes to current schemas upon replay.
  - **Breaking-Change Detection Before Release**: Automated schema diff or breaking-change detection gate prior to release.

---

## 1. Schema Version Fields as Implemented

The canonical event envelope contract is defined in [`src/types/event-envelope.ts`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L17-L62). The version identifiers implemented in the codebase are:

| Field | Type | Current Defined Value | Source Location | Description |
|---|---|---|---|---|
| `schema_version` | `EventEnvelopeSchemaVersion` | `"1.0"` (`EVENT_ENVELOPE_SCHEMA_VERSION`) | [`src/types/event-envelope.ts:17, 19, 42`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L17) | Structural contract version of the envelope wrapper itself. |
| `event_version` | `string` | Unrestricted string (e.g. `"1.0"`) | [`src/types/event-envelope.ts:41`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L41) | Semantic domain payload version for the event payload. |
| `source_version` | `string \| null` | Unrestricted nullable string | [`src/types/event-envelope.ts:54`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L54) | Upstream producer application or component release version. |

In the dashboard-facing event pipeline, [`LiveEvent`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/live.ts#L41) and [`LiveEventIngest`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/live.ts#L52) inherit optional canonical fields via [`EventEnvelopeFields`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/live.ts#L22-L39). They currently omit `schema_version`, `event_version`, and `source_version` to preserve backward compatibility with legacy consumers and producers.

---

## 2. Producer / Consumer Version & Format Matrix

| Component / Subsystem | Role | Emits / Accepts | Version Field Handling | File Reference |
|---|---|---|---|---|
| **Operation Lifecycle** | Producer | Emits `LiveEventIngest` via `pushEvent` | Emits `event_type` (`"operation.started"`, `"operation.completed"`, `"operation.failed"`), `actor`, `resource`, `correlation_id`, `causation_id`, `operation_id`, `request_id`, `visibility`. Does **not** emit `schema_version` or `event_version`. | [`src/lib/operation-context.ts:105-123`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/operation-context.ts#L105-L123) |
| **K8s Informer** | Producer | Emits `LiveEventIngest` via `pushEvent` | Emits coarse `type`, `severity`, `source: "kubernetes"`, `title`, `description`, `resource` (`{ kind, name, namespace }`), `visibility`, and `source_event_id` (`uid:resourceVersion`). Does **not** emit `schema_version` or `event_version`. | [`src/lib/live-k8s-informer.ts:87-134, 194-209`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/live-k8s-informer.ts#L87-L134) |
| **HTTP Ingestion Route** | Producer / Ingest Boundary | Accepts external HTTP JSON; emits `LiveEventIngest` | Ingests webhook payloads from `alertmanager`, `argocd`, `kubernetes`, `manual`. Validates `actor` and `resource`. Does **not** require or validate `schema_version` or `event_version`. Supported legacy producer header `X-Ingest-Producer` alongside `X-Producer-Id`. | [`src/app/api/events/ingest/route.ts:47-391`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/ingest/route.ts#L47-L391) |
| **Live Stream Engine** | Normalizer / Storage | Normalizes `LiveEventIngest` to `LiveEvent`; stores in Valkey list | Normalizes absent optional fields to `null`; assigns monotonic stream ID — either Valkey counter (`String(await valkey.incr(ID_KEY))`, e.g. `"101"`) when healthy, or in-memory degraded fallback `d-<epoch>-<seq>` (`d-${Date.now()}-${sequence}`) — and ISO timestamp. Serializes `LiveEvent` to JSON. Does **not** stamp or require `schema_version`. | [`src/lib/live-stream.ts:78-123`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/live-stream.ts#L78-L123) |
| **Live Stream Replay** | Consumer | Reads from Valkey `RING_KEY` or memory ring | `getRecentEvents` and `replayAfter` deserialize stored strings via `JSON.parse(item) as LiveEvent`. Replays events in monotonic ID sequence without version gating. | [`src/lib/live-stream.ts:125-170`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/live-stream.ts#L125-L170) |
| **SSE Stream Route** | Consumer / Distributor | Consumes from Valkey Pub/Sub; emits SSE | Serializes `LiveEvent` as `id: <id>\nevent: live\ndata: <json>\n\n`. Applies RBAC namespace/visibility filtering via `isEventFiltered`. Does not inspect version fields. | [`src/app/api/events/stream/route.ts:12-14, 107-119`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/stream/route.ts#L12-L14) |
| **Dashboard UI** | Consumer | Reads SSE stream; renders UI | Deserializes SSE event payload via `JSON.parse(e.data) as LiveEvent`. Renders severity, title, actor, and links. Unknown coarse types fall back to default badge/icon rendering. | [`src/hooks/use-live-stream.ts:31`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/hooks/use-live-stream.ts#L31), [`src/components/live/live-stream.tsx:42-120`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/components/live/live-stream.tsx#L42-L120) |
| **Governance Events API** | Producer / Query API | Emits `OperationalEventsResponse` | Maps bounded K8s events to `OperationalEventEntry` (`evidenceKind: "operational-event"`). Legacy alias `/api/governance/audit` deprecated in portal#161 with RFC 9745 `Deprecation: @1790553600` and successor `Link` header. | [`src/lib/governance-operational-events.ts:50-70`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/governance-operational-events.ts#L50-L70), [`src/app/api/governance/audit/route.ts:10-15`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/governance/audit/route.ts#L10-L15) |

---

## 3. Compatibility Rules Enforced by Current Code

The following behavior is enforced by real production validation and parser functions:

### 3.1 Unknown Fields (Forward Compatibility)
- **Ingest Route (`POST /api/events/ingest`)**: The JSON payload is parsed into `Record<string, unknown>`. During assembly of `LiveEventIngest`, known fields are explicitly selected ([`src/app/api/events/ingest/route.ts:356-374`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/ingest/route.ts#L356-L374)). Unknown top-level fields are silently ignored and dropped without raising validation errors (permissive forward compatibility).
- **Actor Validation (`isValidEventActor`)**: Validates that `id` is a non-empty string, `type` is `"user" | "system" | "service"`, and `displayName` is a string if present ([`src/types/event-envelope.ts:65-72`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L65-L72)). Any unexpected extra properties on `actor` (e.g. `roles`, `organization_id`) are ignored and accepted.
- **Resource Validation (`isValidEventResource`)**: Checks only that the defined keys (`cluster`, `namespace`, `kind`, `name`, `workload`) are strings when provided ([`src/types/event-envelope.ts:74-80`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L74-L80)). Additional keys on `resource` are ignored and accepted.
- **Deserialization / Replay**: `JSON.parse` during event replay and stream subscriptions preserves unknown fields on in-memory objects ([`src/lib/live-stream.ts:129, 182`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/live-stream.ts#L129)).

### 3.2 Missing Optional Fields (Backward Compatibility)
- **Canonical Envelope**: All metadata fields except `event_id`, `event_type`, `event_version`, `schema_version`, `occurred_at`, `received_at`, `correlation_id`, `source`, `actor`, and `data` are nullable or optional ([`src/types/event-envelope.ts:38-62`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.ts#L38-L62)).
- **Live Event Pipeline**: In `pushEvent()`, omitted envelope fields (`actor`, `resource`, `operation_id`, `correlation_id`, `causation_id`, `request_id`, `idempotency_key`, `source_event_id`, `event_type`, `visibility`, `producer`, `credential_scope`) default cleanly to `null` ([`src/lib/live-stream.ts:100-106`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/live-stream.ts#L100-L106)).
- **Ingestion Route Requirements**: Required fields are strictly enforced: `type`, `severity`, `title`, and `source` must be non-empty ([`src/app/api/events/ingest/route.ts:133-142`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/ingest/route.ts#L133-L142)). Additionally, deduplication requires at least one of `idempotency_key` or `source_event_id` ([`src/app/api/events/ingest/route.ts:266-276`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/ingest/route.ts#L266-L276)). Requests lacking any of these required fields fail-closed with HTTP 400.

### 3.3 Unknown Event Types
- **Coarse Types (`type`)**: Validated against `VALID_TYPES = ["alert", "deploy", "sync", "node", "operation", "custom"]` ([`src/app/api/events/ingest/route.ts:27, 144-150`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/app/api/events/ingest/route.ts#L27)). Ingestion of any other coarse type fails-closed with HTTP 400.
- **Fine-Grained Event Types (`event_type`)**: Unrestricted string used by internal operations ([`src/lib/operation-context.ts:111`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/lib/operation-context.ts#L111)). Not ingested or validated via `/api/events/ingest`.
- **UI Behavior**: The dashboard filtering categorizes known types; unrecognized event types render in the "all" view using default neutral badges ([`src/components/live/live-stream.tsx:81-88`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/components/live/live-stream.tsx#L81-L88)).

### 3.4 Unknown Versions (Observed Code Behavior)
- **Ingestion Route**: Does **not** validate `schema_version` or `event_version`. Inbound payloads carrying `schema_version: "2.0"` or `"99.0"` are accepted without error so long as the required fields pass validation (fail-open / permissive).
- **Stream Replay**: `JSON.parse` does not check schema versions. Stored events with unsupported version fields are replayed without exception.
- **Type Invariants**: `EVENT_ENVELOPE_SCHEMA_VERSION = "1.0"` is typed as literal `"1.0"`, but no runtime assertion or schema validator checks this constraint on ingress or egress.

---

## 4. Explicit Open Items (Undefined in Current Architecture)

The following capabilities are not currently implemented or specified in the codebase:

1. **Rolling Upgrade Skew Window**:
   - There is no defined protocol or grace period for handling schema skew between old and new Portal pods during a rolling deployment.
   - Valkey ring cache keys for live events do not partition by schema version. If a future version changes the wire format of `LiveEvent`, rolling pods will observe heterogeneous payloads in the same ring buffer.

2. **Narwhal Producer Versions (`narwhal#140`)**:
   - Upstream Narwhal cluster-side producers (e.g. operators, agents, or informers) do not yet have published schema versions or compatibility guarantees against Portal ingestion.
   - Producer contracts remain tracking-only until `narwhal#140` is implemented in the companion repository.

3. **Runtime Schema Version Negotiation & Fail-Closed Enforcement**:
   - Neither `/api/events/ingest` nor the canonical `EventEnvelope` provides a runtime schema validation function (e.g. `isValidEventEnvelope`) to reject unsupported versions (such as `schema_version: "2.0"`).
   - If strict schema evolution is required, a version check must be added to the ingest route and deserialization layer.

4. **Historical Event Replay Translation Layer**:
   - No transformer or adapter pipeline exists to up-cast or deterministically translate older historical event shapes into newer schema versions upon replay.

5. **Breaking-Change Detection Before Release**:
   - There is no automated schema diff or breaking-change detection check in the CI pipeline prior to release.

---

## 5. CI Characterization Test Gate

Contract compatibility fixtures and parser characterization assertions are checked in at [`src/types/event-envelope.compat.test.ts`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/src/types/event-envelope.compat.test.ts).

Automated verification is enforced on every commit and pull request touching `src/**` via the `Unit Test Gate` workflow in [`.github/workflows/test.yml:45-84`](file:///Users/m/Documents/IdeaProjects/20.dasomel/narwhal-portal-38/.github/workflows/test.yml#L45-L84) using `pnpm test`.
