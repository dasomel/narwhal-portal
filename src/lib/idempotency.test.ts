import { describe, expect, it } from "vitest"
import { claimIdempotencyKey, fulfillIdempotencyKey, idempotencyStoreKey, type IdempotencyStore } from "./idempotency"

/** In-memory fake matching the real ValkeyIdempotencyStore's claim/fulfill semantics. */
class FakeIdempotencyStore implements IdempotencyStore {
  private map = new Map<string, string>()

  async claim(key: string, value: string): Promise<string | null> {
    const existing = this.map.get(key)
    if (existing !== undefined) return existing
    this.map.set(key, value)
    return null
  }

  async fulfill(key: string, value: string): Promise<void> {
    this.map.set(key, value)
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

describe("fulfillIdempotencyKey", () => {
  it("overwrites a placeholder claim with the real result — portal#34's claim-then-fulfill flow", async () => {
    const store = new FakeIdempotencyStore()
    // Claim with a placeholder before the real id (e.g. an Alertmanager silence id
    // minted by the downstream call) is known.
    const first = await claimIdempotencyKey(store, "silence-1", "pending", 60)
    expect(first).toBeNull()

    await fulfillIdempotencyKey(store, "silence-1", "silence-abc123", 60)

    const duplicate = await claimIdempotencyKey(store, "silence-1", "pending", 60)
    expect(duplicate).toBe("silence-abc123")
  })
})

describe("idempotencyStoreKey", () => {
  it("namespaces the raw key under the events:idempotency: prefix", () => {
    expect(idempotencyStoreKey("req-1")).toBe("events:idempotency:req-1")
  })
})
