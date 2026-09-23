import { timingSafeEqual } from "crypto"
import type { LiveSource } from "@/types/live"

export type IngestOutcome = "accepted" | "rejected" | "duplicate" | "rate_limited"

export const MAX_INGEST_BODY_SIZE_BYTES = 64 * 1024 // 64 KB
export const MAX_TITLE_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 4096
export const MAX_LINKS_COUNT = 10
export const MAX_TOTAL_LINKS_SIZE_BYTES = 2048
export const MAX_IDENTIFIER_LENGTH = 256

export const KNOWN_PRODUCERS: LiveSource[] = ["alertmanager", "argocd", "kubernetes", "manual"]

/**
 * Constant-time comparison to defeat timing oracles.
 * Mismatched lengths still pay one comparison against a same-length dummy buffer.
 */
export function safeSecretCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Constant-work dummy comparison to mask length mismatch in timing
    timingSafeEqual(a, Buffer.alloc(a.length))
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Parses comma-separated secret values into a list of non-empty tokens.
 */
function parseSecretList(val: string | undefined): string[] {
  if (!val) return []
  return val
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Retrieves configured secrets (current + old for rotation) for a producer.
 */
export function getProducerSecrets(producer: string): string[] {
  const norm = producer.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  const primary = parseSecretList(process.env[`LIVE_INGEST_SECRET_${norm}`])
  const old = parseSecretList(process.env[`LIVE_INGEST_SECRET_${norm}_OLD`])
  return [...primary, ...old]
}

/**
 * Retrieves global fallback ingest secrets (current + old).
 */
export function getGlobalSecrets(): string[] {
  const primary = parseSecretList(process.env.LIVE_INGEST_SECRET)
  const old = parseSecretList(process.env.LIVE_INGEST_SECRET_OLD)
  return [...primary, ...old]
}

export interface ProducerAuthResult {
  authenticated: boolean
  producer: string
  credentialScope: string
  error?: string
}

/**
 * Authenticates an ingest request using constant-time comparison.
 * Supports per-producer credentials and zero-downtime rotation (old + new secrets).
 * Never leaks the provided secret or candidate secrets in error messages.
 */
export function authenticateProducer(
  providedSecret: string,
  producerHint?: string | null,
): ProducerAuthResult {
  if (!providedSecret || providedSecret.trim().length === 0) {
    return {
      authenticated: false,
      producer: producerHint || "unknown",
      credentialScope: "none",
      error: "Missing or empty ingest secret",
    }
  }

  const globalSecrets = getGlobalSecrets()

  if (producerHint) {
    const producerSecrets = getProducerSecrets(producerHint)
    if (producerSecrets.length > 0) {
      const match = producerSecrets.some((s) => safeSecretCompare(providedSecret, s))
      if (match) {
        return {
          authenticated: true,
          producer: producerHint,
          credentialScope: `producer:${producerHint}`,
        }
      }
      return {
        authenticated: false,
        producer: producerHint,
        credentialScope: "none",
        error: `Invalid secret for producer ${producerHint}`,
      }
    }

    // No producer-specific secret configured; check global fallback
    if (globalSecrets.length > 0) {
      const match = globalSecrets.some((s) => safeSecretCompare(providedSecret, s))
      if (match) {
        return {
          authenticated: true,
          producer: producerHint,
          credentialScope: `global:${producerHint}`,
        }
      }
      return {
        authenticated: false,
        producer: producerHint,
        credentialScope: "none",
        error: "Invalid ingest secret",
      }
    }

    return {
      authenticated: false,
      producer: producerHint,
      credentialScope: "none",
      error: "No ingest secrets configured on server",
    }
  }

  // No producer hint: check known producers
  for (const p of KNOWN_PRODUCERS) {
    const secrets = getProducerSecrets(p)
    if (secrets.some((s) => safeSecretCompare(providedSecret, s))) {
      return {
        authenticated: true,
        producer: p,
        credentialScope: `producer:${p}`,
      }
    }
  }

  // Check global fallback
  if (globalSecrets.some((s) => safeSecretCompare(providedSecret, s))) {
    return {
      authenticated: true,
      producer: "shared",
      credentialScope: "global:shared",
    }
  }

  return {
    authenticated: false,
    producer: "unknown",
    credentialScope: "none",
    error: "Invalid ingest secret",
  }
}

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  retryAfterSeconds?: number
}

interface Bucket {
  tokens: number
  lastRefill: number
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>()
  private capacity: number
  private refillRate: number // tokens per second

  constructor(capacity = 30, refillRate = 10) {
    this.capacity = capacity
    this.refillRate = refillRate
  }

  consume(key: string, cost = 1): RateLimitResult {
    const now = Date.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now }
      this.buckets.set(key, bucket)
    } else {
      const elapsedSeconds = (now - bucket.lastRefill) / 1000
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillRate)
      bucket.lastRefill = now
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: this.capacity,
      }
    }

    const deficit = cost - bucket.tokens
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.refillRate))
    return {
      allowed: false,
      remaining: 0,
      limit: this.capacity,
      retryAfterSeconds,
    }
  }

  reset(): void {
    this.buckets.clear()
  }

  getBucketCount(): number {
    return this.buckets.size
  }
}

const defaultRateLimiter = new TokenBucketRateLimiter(
  Number(process.env.LIVE_INGEST_BURST_LIMIT || 30),
  Number(process.env.LIVE_INGEST_RATE_LIMIT || 10),
)
let rateLimiterOverride: TokenBucketRateLimiter | null = null

export function getRateLimiter(): TokenBucketRateLimiter {
  return rateLimiterOverride ?? defaultRateLimiter
}

export function setRateLimiterForTesting(limiter: TokenBucketRateLimiter | null): void {
  rateLimiterOverride = limiter
}

// ---------------------------------------------------------------------------
// Ingest Metrics
// ---------------------------------------------------------------------------

export interface ProducerMetrics {
  accepted: number
  rejected: number
  duplicate: number
  rate_limited: number
}

export interface IngestMetricsSnapshot {
  total_accepted: number
  total_rejected: number
  total_duplicate: number
  total_rate_limited: number
  by_producer: Record<string, ProducerMetrics>
  last_event_at: string | null
}

class IngestMetricsStore {
  private totalAccepted = 0
  private totalRejected = 0
  private totalDuplicate = 0
  private totalRateLimited = 0
  private byProducer = new Map<string, ProducerMetrics>()
  private lastEventAt: string | null = null

  record(outcome: IngestOutcome, producer = "unknown"): void {
    this.lastEventAt = new Date().toISOString()
    let pm = this.byProducer.get(producer)
    if (!pm) {
      pm = { accepted: 0, rejected: 0, duplicate: 0, rate_limited: 0 }
      this.byProducer.set(producer, pm)
    }

    switch (outcome) {
      case "accepted":
        this.totalAccepted++
        pm.accepted++
        break
      case "rejected":
        this.totalRejected++
        pm.rejected++
        break
      case "duplicate":
        this.totalDuplicate++
        pm.duplicate++
        break
      case "rate_limited":
        this.totalRateLimited++
        pm.rate_limited++
        break
    }
  }

  getSnapshot(): IngestMetricsSnapshot {
    const byProducerObj: Record<string, ProducerMetrics> = {}
    for (const [k, v] of this.byProducer.entries()) {
      byProducerObj[k] = { ...v }
    }
    return {
      total_accepted: this.totalAccepted,
      total_rejected: this.totalRejected,
      total_duplicate: this.totalDuplicate,
      total_rate_limited: this.totalRateLimited,
      by_producer: byProducerObj,
      last_event_at: this.lastEventAt,
    }
  }

  reset(): void {
    this.totalAccepted = 0
    this.totalRejected = 0
    this.totalDuplicate = 0
    this.totalRateLimited = 0
    this.byProducer.clear()
    this.lastEventAt = null
  }
}

const metricsStore = new IngestMetricsStore()

export function recordIngestOutcome(outcome: IngestOutcome, producer?: string): void {
  metricsStore.record(outcome, producer)
}

export function getIngestMetrics(): IngestMetricsSnapshot {
  return metricsStore.getSnapshot()
}

export function resetIngestMetricsForTesting(): void {
  metricsStore.reset()
}
