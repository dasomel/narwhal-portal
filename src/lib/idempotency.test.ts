import { describe, expect, it } from "vitest"
import { claimIdempotencyKey, idempotencyStoreKey, type IdempotencyStore } from "./idempotency"

/** In-memory fake matching the real ValkeyIdempotencyStore's claim semantics. */
class FakeIdempotencyStore implements IdempotencyStore {
  private map = new Map<string, string>()

  async claim(key: string, value: string): Promise<string | null> {
    const existing = this.map.get(key)
    if (existing !== undefined) return existing
    this.map.set(key, value)
    return null
  }
}

describe("claimIdempotencyKey", () => {
  it("returns null on the first claim — caller proceeds", async () => {
    const store = new FakeIdempotencyStore()
    const result = await claimIdempotencyKey(store, "req-1", "event-a", 60)
    expect(result).toBeNull()
  })

  it("returns the original value on a duplicate claim — caller short-circuits", async () => {
    const store = new FakeIdempotencyStore()
    await claimIdempotencyKey(store, "req-1", "event-a", 60)
    const result = await claimIdempotencyKey(store, "req-1", "event-b", 60)
    expect(result).toBe("event-a")
  })

  it("treats distinct keys independently", async () => {
    const store = new FakeIdempotencyStore()
    await claimIdempotencyKey(store, "req-1", "event-a", 60)
    const result = await claimIdempotencyKey(store, "req-2", "event-b", 60)
    expect(result).toBeNull()
  })
})

describe("idempotencyStoreKey", () => {
  it("namespaces the raw key under the events:idempotency: prefix", () => {
    expect(idempotencyStoreKey("req-1")).toBe("events:idempotency:req-1")
  })
})
