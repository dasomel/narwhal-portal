import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { POST, GET } from "./route"
import {
  setRateLimiterForTesting,
  TokenBucketRateLimiter,
  resetIngestMetricsForTesting,
  getIngestMetrics,
} from "@/lib/event-ingest"
import {
  InMemoryIdempotencyStore,
  setIdempotencyStoreForTesting,
} from "@/lib/idempotency"

vi.mock("@/lib/live-stream", () => ({
  pushEvent: vi.fn(async (ingest) => ({
    id: ingest.id ?? "mock-event-id-123",
    timestamp: "2026-09-07T00:00:00.000Z",
    ...ingest,
  })),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

const { pushEvent } = await import("@/lib/live-stream")
const { auth } = await import("@/lib/auth")

function createRequest(
  body: unknown,
  options?: {
    secret?: string
    producerId?: string
    ip?: string
    contentLength?: string
    rawText?: string
  },
): Request {
  const headers = new Headers()
  headers.set("Content-Type", "application/json")
  if (options?.secret !== undefined) {
    headers.set("X-Ingest-Secret", options.secret)
  }
  if (options?.producerId) {
    headers.set("X-Producer-Id", options.producerId)
  }
  if (options?.ip) {
    headers.set("X-Forwarded-For", options.ip)
  }
  if (options?.contentLength) {
    headers.set("Content-Length", options.contentLength)
  }

  const bodyStr = options?.rawText !== undefined ? options.rawText : JSON.stringify(body)

  return new Request("http://localhost:3000/api/events/ingest", {
    method: "POST",
    headers,
    body: bodyStr,
  })
}

describe("/api/events/ingest hardening", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    // Configure default producer secrets
    process.env.LIVE_INGEST_SECRET_ALERTMANAGER = "am-secret-123"
    process.env.LIVE_INGEST_SECRET_ARGOCD = "argo-secret-456"
    process.env.LIVE_INGEST_SECRET_KUBERNETES = "k8s-secret-789"
    process.env.LIVE_INGEST_SECRET_MANUAL = "manual-secret-admin"
    process.env.LIVE_INGEST_SECRET = "global-shared-secret"

    vi.mocked(pushEvent).mockClear()
    vi.mocked(auth).mockResolvedValue(null as never)

    // Clean in-memory state
    setIdempotencyStoreForTesting(new InMemoryIdempotencyStore())
    setRateLimiterForTesting(new TokenBucketRateLimiter(30, 10))
    resetIngestMetricsForTesting()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    setIdempotencyStoreForTesting(null)
    setRateLimiterForTesting(null)
    resetIngestMetricsForTesting()
  })

  // -------------------------------------------------------------------------
  // 1. Replay & Idempotency Deduplication
  // -------------------------------------------------------------------------
  describe("Idempotency & Replay Deduplication", () => {
    it("deduplicates replayed events using source_event_id and does not push duplicate", async () => {
      const payload = {
        type: "alert",
        severity: "warning",
        title: "High CPU Usage",
        source: "alertmanager",
        source_event_id: "prom-alert-9999",
      }

      const req1 = createRequest(payload, { secret: "am-secret-123" })
      const res1 = await POST(req1)
      expect(res1.status).toBe(200)
      const data1 = await res1.json()
      expect(data1.ok).toBe(true)
      expect(data1.id).toBeDefined()
      expect(data1.duplicate).toBeUndefined()
      expect(vi.mocked(pushEvent)).toHaveBeenCalledTimes(1)

      // Replay same event with identical source_event_id
      const req2 = createRequest(payload, { secret: "am-secret-123" })
      const res2 = await POST(req2)
      expect(res2.status).toBe(200)
      const data2 = await res2.json()
      expect(data2.ok).toBe(true)
      expect(data2.id).toBe(data1.id) // returns original canonical event ID
      expect(data2.duplicate).toBe(true)
      expect(vi.mocked(pushEvent)).toHaveBeenCalledTimes(1) // pushEvent NOT called again!

      const metrics = getIngestMetrics()
      expect(metrics.total_accepted).toBe(1)
      expect(metrics.total_duplicate).toBe(1)
      expect(metrics.by_producer.alertmanager.duplicate).toBe(1)
    })

    it("deduplicates replayed events using idempotency_key", async () => {
      const payload = {
        type: "deploy",
        severity: "info",
        title: "App deployment started",
        source: "argocd",
        idempotency_key: "deploy-sync-rev-101",
      }

      const req1 = createRequest(payload, { secret: "argo-secret-456" })
      const res1 = await POST(req1)
      const data1 = await res1.json()
      expect(res1.status).toBe(200)
      expect(data1.duplicate).toBeUndefined()
      expect(vi.mocked(pushEvent)).toHaveBeenCalledTimes(1)

      const req2 = createRequest(payload, { secret: "argo-secret-456" })
      const res2 = await POST(req2)
      const data2 = await res2.json()
      expect(res2.status).toBe(200)
      expect(data2.duplicate).toBe(true)
      expect(data2.id).toBe(data1.id)
      expect(vi.mocked(pushEvent)).toHaveBeenCalledTimes(1)
    })

    it("rejects ingest requests missing both idempotency_key and source_event_id", async () => {
      const payload = {
        type: "alert",
        severity: "warning",
        title: "Missing deduplication keys",
        source: "alertmanager",
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("ValidationError")
      expect(data.field).toBe("idempotency_key")
      expect(vi.mocked(pushEvent)).not.toHaveBeenCalled()

      const metrics = getIngestMetrics()
      expect(metrics.total_rejected).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // 2. Payload Bounds & Flooding Rejection
  // -------------------------------------------------------------------------
  describe("Payload Bounds & Flooding Rejection", () => {
    it("rejects request body exceeding 64KB with 413 Payload Too Large", async () => {
      const hugeData = "x".repeat(65 * 1024)
      const payload = {
        type: "alert",
        severity: "info",
        title: "Big Payload",
        source: "alertmanager",
        source_event_id: "evt-big",
        description: hugeData,
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(413)
      const data = await res.json()
      expect(data.error).toBe("Payload Too Large")
      expect(vi.mocked(pushEvent)).not.toHaveBeenCalled()
    })

    it("rejects request with Content-Length header exceeding 64KB immediately", async () => {
      const req = createRequest(
        { type: "alert", severity: "info", title: "Test", source: "alertmanager", source_event_id: "e1" },
        { secret: "am-secret-123", contentLength: "70000" },
      )
      const res = await POST(req)
      expect(res.status).toBe(413)
      expect(vi.mocked(pushEvent)).not.toHaveBeenCalled()
    })

    it("rejects title longer than 256 characters", async () => {
      const longTitle = "a".repeat(257)
      const payload = {
        type: "alert",
        severity: "info",
        title: longTitle,
        source: "alertmanager",
        source_event_id: "evt-title-len",
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.field).toBe("title")
    })

    it("rejects description longer than 4096 characters", async () => {
      const longDesc = "d".repeat(4097)
      const payload = {
        type: "alert",
        severity: "info",
        title: "Valid Title",
        description: longDesc,
        source: "alertmanager",
        source_event_id: "evt-desc-len",
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.field).toBe("description")
    })

    it("rejects links array exceeding 10 items", async () => {
      const links = Array.from({ length: 11 }, (_, i) => ({
        label: `Link ${i}`,
        href: "https://argocd.narwhal.local/app",
      }))

      const payload = {
        type: "deploy",
        severity: "info",
        title: "Deploy with too many links",
        source: "argocd",
        source_event_id: "evt-many-links",
        links,
      }

      const req = createRequest(payload, { secret: "argo-secret-456" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.field).toBe("links")
    })

    it("rejects total links payload size exceeding 2048 bytes", async () => {
      const longLabel = "l".repeat(195)
      // 10 links * 250 chars = 2500 chars > 2048
      const links = Array.from({ length: 10 }, () => ({
        label: longLabel,
        href: "https://argocd.narwhal.local/apps/a-long-path-that-adds-up",
      }))

      const payload = {
        type: "deploy",
        severity: "info",
        title: "Deploy with big links payload",
        source: "argocd",
        source_event_id: "evt-big-links",
        links,
      }

      const req = createRequest(payload, { secret: "argo-secret-456" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.field).toBe("links")
    })
  })

  // -------------------------------------------------------------------------
  // 3. Producer Attribution & Zero-Downtime Rotation
  // -------------------------------------------------------------------------
  describe("Producer Attribution & Credential Rotation", () => {
    it("authenticates and attributes Alertmanager with correct scope", async () => {
      const payload = {
        type: "alert",
        severity: "error",
        title: "Database Down",
        source: "alertmanager",
        source_event_id: "am-evt-1",
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.producer).toBe("alertmanager")
      expect(data.credential_scope).toBe("producer:alertmanager")

      expect(vi.mocked(pushEvent)).toHaveBeenCalledWith(
        expect.objectContaining({
          producer: "alertmanager",
          credential_scope: "producer:alertmanager",
        }),
      )
    })

    it("authenticates and attributes ArgoCD with correct scope", async () => {
      const payload = {
        type: "sync",
        severity: "success",
        title: "Sync Succeeded",
        source: "argocd",
        source_event_id: "argo-evt-1",
      }

      const req = createRequest(payload, { secret: "argo-secret-456" })
      const res = await POST(req)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.producer).toBe("argocd")
      expect(data.credential_scope).toBe("producer:argocd")
    })

    it("supports zero-downtime rotation accepting both old and new credentials", async () => {
      process.env.LIVE_INGEST_SECRET_ALERTMANAGER = "am-new-secret"
      process.env.LIVE_INGEST_SECRET_ALERTMANAGER_OLD = "am-old-secret"

      const payload = {
        type: "alert",
        severity: "info",
        title: "Rotation Test",
        source: "alertmanager",
        source_event_id: "rot-1",
      }

      // 1. Old secret still works
      const reqOld = createRequest(payload, { secret: "am-old-secret" })
      const resOld = await POST(reqOld)
      expect(resOld.status).toBe(200)

      // 2. New secret works
      const payload2 = { ...payload, source_event_id: "rot-2" }
      const reqNew = createRequest(payload2, { secret: "am-new-secret" })
      const resNew = await POST(reqNew)
      expect(resNew.status).toBe(200)

      // 3. Once old secret is removed, it is rejected
      delete process.env.LIVE_INGEST_SECRET_ALERTMANAGER_OLD
      const payload3 = { ...payload, source_event_id: "rot-3" }
      const reqOldRevoked = createRequest(payload3, { secret: "am-old-secret" })
      const resOldRevoked = await POST(reqOldRevoked)
      expect(resOldRevoked.status).toBe(401)
    })

    it("rejects when producer credentials do not match the requested source", async () => {
      // Trying to post Alertmanager events using ArgoCD's secret
      const payload = {
        type: "alert",
        severity: "warning",
        title: "Impersonation Attempt",
        source: "alertmanager",
        source_event_id: "fake-am-1",
      }

      const req = createRequest(payload, { secret: "argo-secret-456" })
      const res = await POST(req)
      expect(res.status).toBe(401)
      expect(vi.mocked(pushEvent)).not.toHaveBeenCalled()
    })

    it("rejects when X-Producer-Id header and body source conflict", async () => {
      const payload = {
        type: "alert",
        severity: "warning",
        title: "Conflicting Producer Headers",
        source: "alertmanager",
        source_event_id: "conflict-1",
      }

      const req = createRequest(payload, {
        secret: "am-secret-123",
        producerId: "kubernetes", // mismatch with body source alertmanager
      })
      const res = await POST(req)
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Rate Limiting & Backpressure (Burst & Sustained Load)
  // -------------------------------------------------------------------------
  describe("Rate Limiting & Backpressure", () => {
    it("allows requests up to burst capacity and throttles with 429 when exhausted", async () => {
      // Capacity: 3 tokens, Refill: 1 token/sec
      setRateLimiterForTesting(new TokenBucketRateLimiter(3, 1))

      const basePayload = {
        type: "alert",
        severity: "info",
        title: "Burst Test",
        source: "alertmanager",
      }

      // 3 burst requests pass
      for (let i = 1; i <= 3; i++) {
        const req = createRequest(
          { ...basePayload, source_event_id: `burst-${i}` },
          { secret: "am-secret-123", ip: "192.168.1.50" },
        )
        const res = await POST(req)
        expect(res.status).toBe(200)
      }

      // 4th burst request is throttled
      const req4 = createRequest(
        { ...basePayload, source_event_id: "burst-4" },
        { secret: "am-secret-123", ip: "192.168.1.50" },
      )
      const res4 = await POST(req4)
      expect(res4.status).toBe(429)
      expect(res4.headers.get("Retry-After")).toBeDefined()
      expect(res4.headers.get("X-RateLimit-Limit")).toBe("3")
      expect(res4.headers.get("X-RateLimit-Remaining")).toBe("0")

      const metrics = getIngestMetrics()
      expect(metrics.total_rate_limited).toBe(1)
      expect(metrics.by_producer.alertmanager.rate_limited).toBe(1)

      // Different IP or producer gets its own rate bucket
      const reqOtherIP = createRequest(
        { ...basePayload, source_event_id: "burst-diff-ip" },
        { secret: "am-secret-123", ip: "192.168.1.51" },
      )
      const resOtherIP = await POST(reqOtherIP)
      expect(resOtherIP.status).toBe(200)
    })

    it("sustained load: refills tokens over time allowing throttled client to resume", async () => {
      vi.useFakeTimers()
      try {
        // Capacity: 2 tokens, Refill: 2 tokens/sec
        setRateLimiterForTesting(new TokenBucketRateLimiter(2, 2))

        const basePayload = {
          type: "alert",
          severity: "info",
          title: "Sustained Test",
          source: "alertmanager",
        }

        // Consume all 2 tokens
        await POST(createRequest({ ...basePayload, source_event_id: "s-1" }, { secret: "am-secret-123" }))
        await POST(createRequest({ ...basePayload, source_event_id: "s-2" }, { secret: "am-secret-123" }))

        // 3rd is throttled
        const resThrottled = await POST(createRequest({ ...basePayload, source_event_id: "s-3" }, { secret: "am-secret-123" }))
        expect(resThrottled.status).toBe(429)

        // Advance time by 1.5 seconds (should refill tokens)
        vi.advanceTimersByTime(1500)

        // 4th request succeeds after token refill
        const resResumed = await POST(createRequest({ ...basePayload, source_event_id: "s-4" }, { secret: "am-secret-123" }))
        expect(resResumed.status).toBe(200)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // -------------------------------------------------------------------------
  // 5. Explicit Credential Failure & Metrics Surface
  // -------------------------------------------------------------------------
  describe("Credential Failure & Metrics Surface", () => {
    it("never logs or exposes the provided secret on unauthorized attempts", async () => {
      const leakedSecretAttempt = "SuperSecretLeakedVal123"
      const payload = {
        type: "alert",
        severity: "info",
        title: "Auth Failure",
        source: "alertmanager",
        source_event_id: "fail-1",
      }

      const req = createRequest(payload, { secret: leakedSecretAttempt })
      const res = await POST(req)
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).not.toContain(leakedSecretAttempt)

      const metrics = getIngestMetrics()
      expect(metrics.total_rejected).toBe(1)
    })

    it("GET /api/events/ingest surfaces metrics when authenticated via session or secret", async () => {
      // 1. Unauthenticated request to GET returns 401
      const unauthReq = new Request("http://localhost:3000/api/events/ingest")
      const unauthRes = await GET(unauthReq)
      expect(unauthRes.status).toBe(401)

      // 2. Ingest some events to generate metrics
      const reqOk = createRequest(
        { type: "alert", severity: "info", title: "Metrics Test", source: "alertmanager", source_event_id: "m-1" },
        { secret: "am-secret-123" },
      )
      await POST(reqOk)

      // 3. Authenticated request via ingest secret returns metrics snapshot
      const authReq = new Request("http://localhost:3000/api/events/ingest", {
        headers: { "X-Ingest-Secret": "am-secret-123" },
      })
      const authRes = await GET(authReq)
      expect(authRes.status).toBe(200)
      const metricsData = await authRes.json()
      expect(metricsData.total_accepted).toBe(1)
      expect(metricsData.by_producer.alertmanager.accepted).toBe(1)
      expect(metricsData.last_event_at).toBeDefined()

      // 4. Authenticated request via user session returns metrics snapshot
      vi.mocked(auth).mockResolvedValue({ user: { name: "Admin", role: "cluster-admin" } } as never)
      const sessionReq = new Request("http://localhost:3000/api/events/ingest")
      const sessionRes = await GET(sessionReq)
      expect(sessionRes.status).toBe(200)
    })

    it("rejects non-allowlisted link host in payload", async () => {
      const payload = {
        type: "alert",
        severity: "info",
        title: "Malicious link",
        source: "alertmanager",
        source_event_id: "link-1",
        links: [{ label: "Bad Link", href: "https://evil.attacker.com/steal" }],
      }

      const req = createRequest(payload, { secret: "am-secret-123" })
      const res = await POST(req)
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("ValidationError")
      expect(data.field).toBe("link.href")
    })
  })
})
