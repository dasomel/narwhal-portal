import { CACHE_NAMESPACES, type CacheInvalidationEvent } from "@/lib/cache-keys"
import { cacheDel, getValkey } from "@/lib/valkey"

export type CacheInvalidationContext = Record<string, string | undefined>

export function invalidationPatternsFor(event: CacheInvalidationEvent): string[] {
  return [...new Set(Object.values(CACHE_NAMESPACES)
    .filter((spec) => spec.invalidationTriggers?.includes(event))
    .flatMap((spec) => spec.invalidationPatterns ?? []))]
}

async function deletePattern(pattern: string): Promise<void> {
  const redis = getValkey()
  let cursor = "0"
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
    cursor = nextCursor
    // SCAN may return cache metadata keys too when the namespace pattern has a glob.
    // UNLINK both forms in one bounded batch; never issue KEYS or block Redis with DEL.
    const batch = [...new Set(keys.flatMap((key) => key.endsWith(":meta") ? [key] : [key, `${key}:meta`]))]
    for (let offset = 0; offset < batch.length; offset += 100) {
      await redis.unlink(...batch.slice(offset, offset + 100))
    }
  } while (cursor !== "0")
}

export async function invalidateFor(event: CacheInvalidationEvent, context: CacheInvalidationContext = {}): Promise<void> {
  for (const pattern of invalidationPatternsFor(event)) {
    try {
      if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
        await cacheDel(pattern)
      } else {
        await deletePattern(pattern)
      }
    } catch (error) {
      console.error("[cache-invalidation] failed", { event, pattern, context, error })
    }
  }
}
