import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EVENT_ENVELOPE_SCHEMA_VERSION,
  isValidEventActor,
  isValidEventResource,
  type EventEnvelope,
} from "./event-envelope"
import type { LiveEvent, LiveEventIngest } from "./live"
import { POST } from "@/app/api/events/ingest/route"
import {
  InMemoryIdempotencyStore,
  setIdempotencyStoreForTesting,
} from "@/lib/idempotency"
import {
  TokenBucketRateLimiter,
  resetIngestMetricsForTesting,
  setRateLimiterForTesting,
} from "@/lib/event-ingest"

// In-memory backing state for Valkey simulation
const valkeyState = vi.hoisted(() => ({
  ring: [] as string[],
  counter: BigInt(100),
}))

vi.mock("@/lib/valkey", () => ({
  getLiveValkey: () => ({
    incr: async () => {
      valkeyState.counter += BigInt(1)
      return valkeyState.counter.toString()
    },
    pipeline: () => {
      let pending: string | undefined
      const pipe = {
        lpush: (_key: string, payload: string) => {
          pending = payload
          return pipe
        },
        ltrim: () => pipe,
        publish: () => pipe,
        exec: async () => {
          if (pending) {
            valkeyState.ring.unshift(pending)
          }
          return [[null, 1]]
        },
      }
      return pipe
    },
    lrange: async (_key: string, start: number, end: number) => {
      return valkeyState.ring.slice(start, end + 1)
    },
  }),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue(null),
}))

const { pushEvent, getRecentEvents, replayAfter } = await import("@/lib/live-stream")

// ============================================================================
// CHECKED-IN CONTRACT FIXTURES (portal#38)
// ============================================================================

/** Fixture 1: Canonical Event Envelope v1.0 (canonical format from portal#11) */
export const FIXTURE_CURRENT_V1_CANONICAL: EventEnvelope = {
  event_id: "evt-v1-20260929-001",
  event_type: "operation.completed",
  event_version: "1.0",
  schema_version: EVENT_ENVELOPE_SCHEMA_VERSION, // "1.0"
  occurred_at: "2026-09-29T00:00:00.000Z",
  received_at: "2026-09-29T00:00:00.050Z",
  correlation_id: "corr-v1-100",
  causation_id: "cause-v1-099",
  request_id: "req-v1-100",
  operation_id: "op-v1-100",
  incident_id: null,
  evidence_id: null,
  trace_id: "trace-v1-abc",
  span_id: "span-v1-def",
  source: "argocd",
  source_version: "v2.10.0",
  producer: "argocd",
  credential_scope: "argocd-token",
  actor: {
    id: "admin@narwhal.local",
    type: "user",
    displayName: "Admin User",
  },
  resource: {
    cluster: "narwhal-prod",
    namespace: "production",
    kind: "Application",
    name: "payment-service",
    workload: "payment-deploy",
  },
  idempotency_key: "idem-v1-100",
  source_event_id: "src-v1-100",
  data: {
    syncStatus: "Synced",
    healthStatus: "Healthy",
  },
}

/** Fixture 2: Current Ingest Payload with canonical envelope fields */
export const FIXTURE_CURRENT_V1_INGEST = {
  type: "deploy" as const,
  severity: "info" as const,
  title: "Service deployed successfully",
  description: "ArgoCD synced revision main@sha256:abcd",
  source: "argocd" as const,
  idempotency_key: "idem-ingest-v1-200",
  source_event_id: "argo-app-sync-200",
  correlation_id: "corr-ingest-200",
  causation_id: "cause-ingest-199",
  operation_id: "op-ingest-200",
  actor: {
    id: "ci-service@narwhal.local",
    type: "service" as const,
    displayName: "CI Deploy Bot",
  },
  resource: {
    cluster: "narwhal-prod",
    namespace: "team-alpha",
    kind: "Deployment",
    name: "orders-api",
    workload: "orders-api-workload",
  },
  visibility: "namespace" as const,
}

/** Fixture 3: Older/minimal shape (historical pre-envelope shape, omitting optional envelope fields) */
export const FIXTURE_OLDER_MINIMAL_INGEST = {
  type: "custom" as const,
  severity: "info" as const,
  title: "Historical legacy event",
  description: "Emitted without structured actor, resource, or causation chaining",
  source: "manual" as const,
  idempotency_key: "legacy-idem-300",
}

/** Fixture 4: Forward-compatible envelope carrying unknown future fields */
export const FIXTURE_FORWARD_COMPAT_INGEST = {
  type: "deploy" as const,
  severity: "info" as const,
  title: "Canary deployment started",
  description: "Includes future v2 envelope fields not yet recognized by v1 schema",
  source: "kubernetes" as const,
  idempotency_key: "forward-compat-idem-400",
  // Unknown top-level fields
  schema_version: "1.0",
  future_envelope_flags: { canary: true, traffic_pct: 10 },
  unknown_preview_attribute: "preview-flag-xyz",
  // Actor with extra unknown properties
  actor: {
    id: "operator@narwhal.local",
    type: "user" as const,
    displayName: "Platform Operator",
    tier: "enterprise-superadmin",
    mfa_verified: true,
  },
  // Resource with extra unknown properties
  resource: {
    cluster: "narwhal-prod",
    namespace: "production",
    kind: "Deployment",
    name: "auth-service",
    workload: "auth-workload",
    cloud_provider_arn: "arn:aws:eks:us-east-1:123456789:cluster/prod",
    custom_labels: { env: "prod", tier: "frontend" },
  },
}

/** Fixture 5: Unknown / Unsupported version envelope (future v2.0 schema) */
export const FIXTURE_UNSUPPORTED_VERSION_INGEST = {
  type: "alert" as const,
  severity: "warning" as const,
  title: "Alert from future producer v2.0",
  description: "Producer is emitting schema_version 2.0 with event_version 99.0",
  source: "alertmanager" as const,
  idempotency_key: "unsupported-version-idem-500",
  schema_version: "2.0",
  event_version: "99.0",
  source_version: "v9.9.9",
}

// Helper to construct test Request objects
function createRequest(
  body: unknown,
  options?: {
    secret?: string
    producerId?: string
    legacyHeaderProducer?: string
  },
): Request {
  const headers = new Headers({ "Content-Type": "application/json" })
  if (options?.secret !== undefined) {
    headers.set("X-Ingest-Secret", options.secret)
  }
  if (options?.producerId) {
    headers.set("X-Producer-Id", options.producerId)
  }
  if (options?.legacyHeaderProducer) {
    headers.set("X-Ingest-Producer", options.legacyHeaderProducer)
  }
  return new Request("http://localhost:3000/api/events/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("Event Envelope Contract Characterization Tests (portal#38)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.LIVE_INGEST_SECRET_ALERTMANAGER = "am-secret-123"
    process.env.LIVE_INGEST_SECRET_ARGOCD = "argo-secret-456"
    process.env.LIVE_INGEST_SECRET_KUBERNETES = "k8s-secret-789"
    process.env.LIVE_INGEST_SECRET_MANUAL = "manual-secret-admin"

    setIdempotencyStoreForTesting(new InMemoryIdempotencyStore())
    setRateLimiterForTesting(new TokenBucketRateLimiter(50, 10))
    resetIngestMetricsForTesting()

    valkeyState.ring = []
    valkeyState.counter = BigInt(100)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    setIdempotencyStoreForTesting(null)
    setRateLimiterForTesting(null)
    resetIngestMetricsForTesting()
  })

  // -------------------------------------------------------------------------
  // 1. Ingestion Route Compatibility (/api/events/ingest)
  // -------------------------------------------------------------------------
  describe("Ingestion Route Compatibility (/api/events/ingest)", () => {
    it("successfully ingests current v1 envelope payload", async () => {
      const req = createRequest(FIXTURE_CURRENT_V1_INGEST, {
        secret: "argo-secret-456",
        producerId: "argocd",
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.id).toBeDefined()
      expect(body.producer).toBe("argocd")

      // Verify the pushed event in Valkey ring contains structured envelope fields
      expect(valkeyState.ring).toHaveLength(1)
      const stored = JSON.parse(valkeyState.ring[0]) as LiveEvent
      expect(stored.actor?.id).toBe("ci-service@narwhal.local")
      expect(stored.resource?.namespace).toBe("team-alpha")
      expect(stored.correlation_id).toBe("corr-ingest-200")
      expect(stored.visibility).toBe("namespace")
    })

    it("successfully ingests older/minimal shape and normalizes missing envelope fields to null", async () => {
      const req = createRequest(FIXTURE_OLDER_MINIMAL_INGEST, {
        secret: "manual-secret-admin",
        producerId: "manual",
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      expect(valkeyState.ring).toHaveLength(1)
      const stored = JSON.parse(valkeyState.ring[0]) as LiveEvent
      expect(stored.title).toBe(FIXTURE_OLDER_MINIMAL_INGEST.title)
      // Assert deterministic normalization of omitted envelope fields to null
      expect(stored.actor).toBeNull()
      expect(stored.resource).toBeNull()
      expect(stored.correlation_id).toBeNull()
      expect(stored.causation_id).toBeNull()
      expect(stored.operation_id).toBeNull()
      expect(stored.visibility).toBeNull()
    })

    it("supports legacy producer header alias X-Ingest-Producer alongside X-Producer-Id", async () => {
      const req = createRequest(FIXTURE_OLDER_MINIMAL_INGEST, {
        secret: "manual-secret-admin",
        legacyHeaderProducer: "manual", // Legacy header alias
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.producer).toBe("manual")
    })

    it("accepts forward-compat payload: drops unknown top-level fields while retaining nested unknown metadata", async () => {
      // Sub-object validators permit unknown future properties (permissive forward compatibility)
      expect(isValidEventActor(FIXTURE_FORWARD_COMPAT_INGEST.actor)).toBe(true)
      expect(isValidEventResource(FIXTURE_FORWARD_COMPAT_INGEST.resource)).toBe(true)

      const req = createRequest(FIXTURE_FORWARD_COMPAT_INGEST, {
        secret: "k8s-secret-789",
        producerId: "kubernetes",
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      expect(valkeyState.ring).toHaveLength(1)
      const stored = JSON.parse(valkeyState.ring[0]) as LiveEvent
      expect(stored.actor?.id).toBe("operator@narwhal.local")
      expect(stored.resource?.name).toBe("auth-service")

      // Forward-compat rule: unknown top-level envelope fields are dropped during LiveEventIngest assembly
      expect((stored as unknown as Record<string, unknown>).future_envelope_flags).toBeUndefined()
      expect((stored as unknown as Record<string, unknown>).unknown_preview_attribute).toBeUndefined()

      // Forward-compat rule: unknown properties on nested structured objects (actor, resource) are retained
      expect((stored.actor as unknown as Record<string, unknown>).tier).toBe("enterprise-superadmin")
      expect((stored.actor as unknown as Record<string, unknown>).mfa_verified).toBe(true)
      expect((stored.resource as unknown as Record<string, unknown>).cloud_provider_arn).toBe(
        "arn:aws:eks:us-east-1:123456789:cluster/prod",
      )
    })
  })

  // -------------------------------------------------------------------------
  // 2. Historical Event Replay & Stream Deserialization
  // -------------------------------------------------------------------------
  describe("Historical Event Replay & Valkey Ring Deserialization", () => {
    it("replays stored events maintaining all v1 envelope fields", async () => {
      const ingest: LiveEventIngest = {
        type: "deploy",
        severity: "info",
        title: "Event 101",
        description: "Replay test",
        source: "argocd",
        idempotency_key: "replay-key-101",
        actor: { id: "user-1", type: "user", displayName: "Tester" },
        resource: { namespace: "prod", name: "svc" },
        correlation_id: "corr-101",
      }

      const event = await pushEvent(ingest)
      expect(event.id).toBe("101")

      const recent = await getRecentEvents(10)
      expect(recent).toHaveLength(1)
      expect(recent[0].id).toBe("101")
      expect(recent[0].actor?.displayName).toBe("Tester")
      expect(recent[0].resource?.namespace).toBe("prod")
    })

    it("replays historical events written with older/minimal shapes without throwing", async () => {
      // Simulate historical events directly in storage from before portal#11/12
      const cursorRaw = JSON.stringify({
        id: "100",
        type: "custom",
        severity: "info",
        timestamp: "2025-12-31T23:59:00.000Z",
        title: "Initial cursor event",
        description: "Cursor anchor",
        source: "manual",
        links: null,
      })
      const historicalOlderRaw = JSON.stringify({
        id: "101",
        type: "custom",
        severity: "info",
        timestamp: "2026-01-01T00:00:00.000Z",
        title: "Historical Event without envelope",
        description: "Pre-portal#11 event",
        source: "manual",
        links: null,
      })
      const currentRaw = JSON.stringify({
        id: "102",
        type: "deploy",
        severity: "info",
        timestamp: "2026-01-01T00:01:00.000Z",
        title: "Current Event with envelope",
        description: "Portal#11 event",
        source: "argocd",
        links: null,
        actor: { id: "bot", type: "service" },
        resource: { namespace: "default" },
      })

      // Stored newest first in Valkey list
      valkeyState.ring = [currentRaw, historicalOlderRaw, cursorRaw]

      const replay = await replayAfter("100")
      expect(replay.gap).toBe(false)
      expect(replay.unknown).toBe(false)
      expect(replay.events).toHaveLength(2)

      // Event 101 has absent envelope fields; safely accessible as undefined
      const e101 = replay.events[0]
      expect(e101.id).toBe("101")
      expect(e101.actor).toBeUndefined()
      expect(e101.resource).toBeUndefined()

      // Event 102 has populated envelope fields
      const e102 = replay.events[1]
      expect(e102.id).toBe("102")
      expect(e102.actor?.id).toBe("bot")
      expect(e102.resource?.namespace).toBe("default")
    })

    it("replays historical events carrying unexpected forward-compat fields (JSON.parse retains them)", async () => {
      const historicalForwardRaw = JSON.stringify({
        id: "101",
        type: "deploy",
        severity: "info",
        timestamp: "2026-01-01T00:00:00.000Z",
        title: "Event with unknown future metadata",
        description: "Written by newer version pod",
        source: "kubernetes",
        links: null,
        future_tag: "v2-canary",
        schema_version: "2.0",
      })

      valkeyState.ring = [historicalForwardRaw]

      const recent = await getRecentEvents(5)
      expect(recent).toHaveLength(1)
      expect(recent[0].id).toBe("101")
      // In JavaScript runtime, unknown fields remain present on the parsed object
      expect((recent[0] as unknown as Record<string, unknown>).future_tag).toBe("v2-canary")
      expect((recent[0] as unknown as Record<string, unknown>).schema_version).toBe("2.0")
    })
  })

  // -------------------------------------------------------------------------
  // 3. Characterization: Fail-Open Version Handling (#38 AC-5 open)
  // -------------------------------------------------------------------------
  describe("Characterization: Current Fail-Open Version Handling (#38 AC-5 open)", () => {
    it("characterization (#38 AC-5 open): unsupported schema_version is currently accepted fail-open at ingest", async () => {
      // CHARACTERIZATION ONLY (#38 AC-5 open): Current production ingest route has no
      // schema_version validation and accepts unsupported versions (fail-open).
      // When a fail-closed version policy is decided by maintainers, this test must be
      // replaced by a 4xx assertion with structured diagnostic error details.
      // Do not use it.fails here.
      const req = createRequest(FIXTURE_UNSUPPORTED_VERSION_INGEST, {
        secret: "am-secret-123",
        producerId: "alertmanager",
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)

      expect(valkeyState.ring).toHaveLength(1)
      const stored = JSON.parse(valkeyState.ring[0]) as LiveEvent
      expect(stored.title).toBe(FIXTURE_UNSUPPORTED_VERSION_INGEST.title)
      // schema_version is not modeled on LiveEvent and was dropped during ingest
      expect((stored as unknown as Record<string, unknown>).schema_version).toBeUndefined()
    })

    it("characterization (#38 AC-5 open): unsupported schema_version in storage is replayed without error (fail-open)", async () => {
      // CHARACTERIZATION ONLY (#38 AC-5 open): Stored events carrying unsupported
      // schema_version currently deserialize cleanly via JSON.parse without gating (fail-open).
      // When a fail-closed or replay translation policy is decided by maintainers, this test
      // must be replaced by a diagnostic assertion.
      // Do not use it.fails here.
      const v99Raw = JSON.stringify({
        id: "101",
        type: "alert",
        severity: "warning",
        timestamp: "2026-01-01T00:00:00.000Z",
        title: "Event from future v99",
        description: "Unsupported schema version",
        source: "alertmanager",
        schema_version: "99.0",
        event_version: "99.0",
      })

      valkeyState.ring = [v99Raw]

      const recent = await getRecentEvents(1)
      expect(recent).toHaveLength(1)
      expect(recent[0].id).toBe("101")
      expect(recent[0].title).toBe("Event from future v99")
      expect((recent[0] as unknown as Record<string, unknown>).schema_version).toBe("99.0")
    })
  })
})
