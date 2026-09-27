import { beforeEach, describe, expect, it, vi } from "vitest"

const { cacheDel, getValkey, scan, unlink } = vi.hoisted(() => ({
  cacheDel: vi.fn(),
  getValkey: vi.fn(),
  scan: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock("@/lib/valkey", () => ({ cacheDel, getValkey }))

import { invalidateFor, invalidationPatternsFor } from "@/lib/cache-invalidation"

describe("cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getValkey.mockReturnValue({ scan, unlink })
    scan.mockImplementation(async (_cursor: string, _match: string, pattern: string) => [
      "0",
      pattern === "my-apps:*" ? ["my-apps:u1:scope1", "my-apps:u2:scope2", "my-apps:u1:scope1:meta"] : [],
    ])
    unlink.mockResolvedValue(3)
  })

  it("maps IAM changes to registered scope-fingerprinted projections", () => {
    expect(invalidationPatternsFor("iam.changed")).toEqual(expect.arrayContaining([
      "my-apps:*",
      "governance:resources:v3:*",
      "governance:dora:v2:*",
      "governance:scorecard:*",
      "events:timeline:*",
    ]))
  })

  it("uses SCAN and UNLINK for prefixes and removes metadata siblings", async () => {
    await invalidateFor("iam.changed")

    expect(scan).toHaveBeenCalledWith("0", "MATCH", expect.any(String), "COUNT", 100)
    expect(scan.mock.calls.some((call) => call.includes("KEYS"))).toBe(false)
    expect(unlink).toHaveBeenCalledWith("my-apps:u1:scope1", "my-apps:u1:scope1:meta", "my-apps:u2:scope2", "my-apps:u2:scope2:meta")
  })

  it("uses cacheDel for exact keys", async () => {
    await invalidateFor("apisix.route.changed")
    expect(cacheDel).toHaveBeenCalledWith("api:routes-list")
    expect(cacheDel).toHaveBeenCalledWith("apisix:routes")
  })

  it("logs prefix deletion failures without rejecting the mutation caller", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    unlink.mockRejectedValueOnce(new Error("Valkey unavailable"))
    await expect(invalidateFor("iam.changed")).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith("[cache-invalidation] failed", expect.objectContaining({ event: "iam.changed", pattern: "my-apps:*" }))
    error.mockRestore()
  })
})
