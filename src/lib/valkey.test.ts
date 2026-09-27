import { beforeEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, string>()
const ttls = new Map<string, number>()
vi.mock("ioredis", () => ({
  default: class {
    on() { return this }
    async get(key: string) { return store.get(key) ?? null }
    async mget(...keys: string[]) { return keys.map((key) => store.get(key) ?? null) }
    async del(...keys: string[]) {
      for (const key of keys) { store.delete(key); ttls.delete(key) }
      return keys.length
    }
    multi() {
      const commands: Array<[string, string, number]> = []
      return {
        set(key: string, value: string, _expiry: string, ttl: number) { commands.push([key, value, ttl]); return this },
        async exec() {
          for (const [key, value, ttl] of commands) { store.set(key, value); ttls.set(key, ttl) }
          return commands.map(() => ["OK", "OK"])
        },
      }
    }
  },
}))

const { cacheDel, cacheGet, cacheGetWithMeta, cacheSet } = await import("./valkey")

describe("Valkey cached value metadata", () => {
  beforeEach(() => {
    store.clear()
    ttls.clear()
    vi.useRealTimers()
  })

  it("stores the bare value for old readers and captures metadata with the same TTL", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"))
    await cacheSet("test", { answer: 42 }, 60)
    expect(store.get("test")).toBe(JSON.stringify({ answer: 42 }))
    expect(JSON.parse(store.get("test")!)).toEqual({ answer: 42 })
    expect(ttls.get("test:meta")).toBe(ttls.get("test"))
    vi.setSystemTime(new Date("2026-09-28T00:01:30.000Z"))

    await expect(cacheGetWithMeta<{ answer: number }>("test")).resolves.toEqual({
      value: { answer: 42 },
      cachedAt: "2026-09-28T00:00:00.000Z",
      ageSeconds: 90,
    })
    await expect(cacheGet<{ answer: number }>("test")).resolves.toEqual({ answer: 42 })
  })

  it("reads a legacy bare value with unknown age", async () => {
    store.set("legacy", JSON.stringify({ value: "old-shape" }))

    await expect(cacheGetWithMeta<{ value: string }>("legacy")).resolves.toEqual({
      value: { value: "old-shape" },
      cachedAt: null,
      ageSeconds: null,
    })
    await expect(cacheGet<{ value: string }>("legacy")).resolves.toEqual({ value: "old-shape" })
  })

  it("returns unknown age when metadata is missing", async () => {
    store.set("old-writer", JSON.stringify({ bare: true }))
    await expect(cacheGetWithMeta<{ bare: boolean }>("old-writer")).resolves.toEqual({
      value: { bare: true }, cachedAt: null, ageSeconds: null,
    })
  })

  it("deletes the value and its metadata", async () => {
    await cacheSet("delete-me", { present: true }, 60)
    await cacheDel("delete-me")
    expect(store.has("delete-me")).toBe(false)
    expect(store.has("delete-me:meta")).toBe(false)
  })
})
