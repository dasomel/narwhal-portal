import Redis from "ioredis"

let client: Redis | null = null
let isValkeyConnected = true

function assertProductionSecurity(): void {
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
    await getValkey().set(key, JSON.stringify(value), "EX", ttlSeconds)
  } catch {
    isValkeyConnected = false
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!isValkeyConnected) return
  try {
    await getValkey().del(key)
  } catch {
    isValkeyConnected = false
  }
}
