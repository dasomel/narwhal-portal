import Redis from "ioredis"

let client: Redis | null = null
let isValkeyConnected = true

function assertProductionSecurity(): void {
  if (process.env.VALKEY_INSECURE_PRODUCTION === "true") {
    if (!process.env.VALKEY_PASSWORD) {
      console.warn("[Valkey] VALKEY_PASSWORD is not set in insecure production mode")
    }
    return
  }
  if (process.env.NODE_ENV !== "production") {
    if (!process.env.VALKEY_PASSWORD) {
      console.warn("[Valkey] VALKEY_PASSWORD is not set — connection may fail if AUTH is required")
    }
    if (process.env.VALKEY_TLS !== "true") {
      console.warn("[Valkey] VALKEY_TLS is not enabled — use TLS in production")
    }
    return
  }
  if (process.env.VALKEY_TLS !== "true") {
    throw new Error("[Valkey] VALKEY_TLS must be 'true' in production")
  }
  if (!process.env.VALKEY_PASSWORD) {
    throw new Error("[Valkey] VALKEY_PASSWORD is required in production")
  }
}

export function getValkey(): Redis {
  if (!client) {
    assertProductionSecurity()
    const tlsEnabled = process.env.VALKEY_TLS === "true"
    const password = process.env.VALKEY_PASSWORD

    client = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 500,
      commandTimeout: 500,
      ...(tlsEnabled ? { tls: {} } : {}),
      ...(password ? { password } : {}),
    })
    client.on("error", (err) => {
      if (isValkeyConnected) {
        if (process.env.NODE_ENV !== "development") {
          console.error("[Valkey] Cache disabled.", err.message)
        } else {
          console.warn("[Valkey] Cache disabled (Dev mode). Skipping Valkey connections.")
        }
        isValkeyConnected = false
      }
    })
    client.on("connect", () => {
      console.log("[Valkey] Connected to cache server.")
      isValkeyConnected = true
    })
  }
  return client
}

let liveClient: Redis | null = null

/**
 * Dedicated Valkey client for the live event stream (pub/sub + pipelines).
 *
 * The cache client (getValkey) is tuned fail-fast — `commandTimeout: 500` and
 * `maxRetriesPerRequest: 1` — which is correct for best-effort caching (miss →
 * fall back to a direct fetch) but breaks the live stream: a long-lived SUBSCRIBE
 * and the LPUSH+LTRIM+PUBLISH pipeline get cut off / dropped, so events never reach
 * Valkey and the stream falls into permanent degraded (in-memory) mode. This client
 * is lenient: no per-command timeout and unlimited retries (required for pub/sub).
 */
export function getLiveValkey(): Redis {
  if (!liveClient) {
    assertProductionSecurity()
    const tlsEnabled = process.env.VALKEY_TLS === "true"
    const password = process.env.VALKEY_PASSWORD

    liveClient = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // pub/sub must not drop commands
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 3000,
      // deliberately NO commandTimeout: SUBSCRIBE is long-lived and pipelines
      // must not be aborted mid-flight.
      ...(tlsEnabled ? { tls: {} } : {}),
      ...(password ? { password } : {}),
    })
    liveClient.on("error", (err) => {
      console.warn("[live-valkey] connection error:", err.message)
    })
  }
  return liveClient
}

export interface CachedValue<T> {
  value: T
  cachedAt: string | null
  ageSeconds: number | null
}

interface CacheMetadata {
  cachedAt: string
}

export async function cacheGetWithMeta<T>(key: string): Promise<CachedValue<T> | null> {
  if (!isValkeyConnected) return null
  try {
    const [val, meta] = await getValkey().mget(key, `${key}:meta`)
    if (val === null) return null
    const parsed: unknown = JSON.parse(val)
    if (parsed === null) return null
    const metadata: unknown = meta === null ? null : JSON.parse(meta)
    const cachedAt =
      typeof metadata === "object" && metadata !== null &&
      "cachedAt" in metadata && typeof (metadata as CacheMetadata).cachedAt === "string" &&
      Number.isFinite(Date.parse((metadata as CacheMetadata).cachedAt))
        ? (metadata as CacheMetadata).cachedAt
        : null
    if (cachedAt !== null) {
      return { value: parsed as T, cachedAt, ageSeconds: Math.max(0, (Date.now() - Date.parse(cachedAt)) / 1000) }
    }
    return { value: parsed as T, cachedAt: null, ageSeconds: null }
  } catch {
    isValkeyConnected = false
    return null
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isValkeyConnected) return null
  try {
    const val = await getValkey().get(key)
    return val ? (JSON.parse(val) as T) : null
  } catch {
    isValkeyConnected = false
    return null
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isValkeyConnected) return
  try {
    const cachedAt = new Date().toISOString()
    await getValkey().multi()
      .set(key, JSON.stringify(value), "EX", ttlSeconds)
      .set(`${key}:meta`, JSON.stringify({ cachedAt }), "EX", ttlSeconds)
      .exec()
  } catch {
    isValkeyConnected = false
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!isValkeyConnected) return
  try {
    await getValkey().del(key, `${key}:meta`)
  } catch (error) {
    console.error("[Valkey] Cache key deletion failed.", error instanceof Error ? error.message : error)
    isValkeyConnected = false
  }
}
