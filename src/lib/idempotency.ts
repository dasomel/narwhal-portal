/**
 * Idempotency-key dedup store for /api/events/ingest (portal#11).
 *
 * The store is an injectable interface (not a direct ioredis call) so the dedup
 * decision — claimIdempotencyKey — is unit-testable with an in-memory fake, the
 * same way src/lib/gitea.test.ts keeps the pure logic testable and leaves the
 * real Valkey-touching half to be verified by hand against a live instance.
 */
import { getValkey } from "./valkey"

const KEY_PREFIX = "events:idempotency:"
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export function idempotencyStoreKey(key: string): string {
  return `${KEY_PREFIX}${key}`
}

export interface IdempotencyStore {
  /**
   * Atomically claims `key` with `value` if it hasn't been claimed yet.
   * Returns `null` if this call claimed it (first time — proceed).
   * Returns the previously-claimed value if `key` was already claimed (duplicate — short-circuit).
   */
  claim(key: string, value: string, ttlSeconds: number): Promise<string | null>
  /**
   * Overwrites `key`'s value after the caller has finished acting on its claim —
   * for a producer whose real result id (e.g. an Alertmanager silence id) isn't
   * known until after the claim succeeds, unlike /api/events/ingest which mints its
   * own id up front and claims with that. Best-effort: a failure here only means a
   * later duplicate falls through to the placeholder value claim() stored instead
   * of the real result, not that dedup breaks entirely.
   */
  fulfill(key: string, value: string, ttlSeconds: number): Promise<void>
}

/**
 * Valkey-backed store: SET key value EX ttl NX, falling back to GET on a miss to
 * report the existing value. Fail-open on any Valkey error — never block event
 * ingestion on dedup availability, mirroring cacheGet/cacheSet's fail-open
 * behavior in src/lib/valkey.ts.
 */
export class ValkeyIdempotencyStore implements IdempotencyStore {
  async claim(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    try {
      const client = getValkey()
      const result = await client.set(key, value, "EX", ttlSeconds, "NX")
      if (result === "OK") return null
      const existing = await client.get(key)
      // existing === null here would mean the key expired between SET NX and GET —
      // treat that race as "not a duplicate" (this call effectively wins).
      return existing
    } catch {
      return null
    }
  }

  async fulfill(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      const client = getValkey()
      await client.set(key, value, "EX", ttlSeconds)
    } catch {
      // Fail-open — see interface doc.
    }
  }
}

const defaultStore = new ValkeyIdempotencyStore()

export function getIdempotencyStore(): IdempotencyStore {
  return defaultStore
}

/**
 * Claims an idempotency key against `store`. Returns the id of the original
 * event when `key` is a duplicate within the TTL window, or `null` when this is
 * the first time `key` has been seen (the caller should proceed).
 */
export async function claimIdempotencyKey(
  store: IdempotencyStore,
  key: string,
  value: string,
  ttlSeconds: number = IDEMPOTENCY_TTL_SECONDS,
): Promise<string | null> {
  return store.claim(idempotencyStoreKey(key), value, ttlSeconds)
}

/**
 * Overwrites a previously-claimed key with its real result — see
 * IdempotencyStore.fulfill for when this is needed over a plain claim().
 */
export async function fulfillIdempotencyKey(
  store: IdempotencyStore,
  key: string,
  value: string,
  ttlSeconds: number = IDEMPOTENCY_TTL_SECONDS,
): Promise<void> {
  return store.fulfill(idempotencyStoreKey(key), value, ttlSeconds)
}
