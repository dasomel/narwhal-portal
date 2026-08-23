import { describe, expect, it, vi } from "vitest"

// auth.ts calls NextAuth(config) at module load time, which pulls in next-auth's
// "next/server" import — that subpath fails to resolve under vitest's plain-Node
// environment (pre-existing, unrelated to this change: reproduces with a bare
// `node -e "import('next/server')"` too). These modules aren't exercised by the
// pure-function tests below, so stub them out rather than loading the real thing.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))

const { classifyGroupClaim, getRoleFromGroups, sanitizeGroups, unknownGroups } = await import(
  "./auth"
)

describe("sanitizeGroups", () => {
  it("keeps known groups", () => expect(sanitizeGroups(["developer"])).toEqual(["developer"]))
  it("drops unrecognized groups", () =>
    expect(sanitizeGroups(["some-random-idp-group"])).toEqual([]))
  it("keeps known and drops unknown from a mixed list", () =>
    expect(sanitizeGroups(["developer", "some-random-group"])).toEqual(["developer"]))
  it("empty/absent input sanitizes to an empty list", () => {
    expect(sanitizeGroups([])).toEqual([])
    expect(sanitizeGroups(undefined)).toEqual([])
  })
})

describe("unknownGroups", () => {
  it("is empty for fully known input", () => expect(unknownGroups(["developer"])).toEqual([]))
  it("surfaces unrecognized values", () =>
    expect(unknownGroups(["some-random-idp-group"])).toEqual(["some-random-idp-group"]))
  it("surfaces the unknown one even when a known group is also present", () =>
    expect(unknownGroups(["developer", "some-random-group"])).toEqual(["some-random-group"]))
})

describe("classifyGroupClaim", () => {
  it("known groups -> ok", () => expect(classifyGroupClaim(["developer"])).toBe("ok"))
  it("entirely unrecognized groups -> unknown_groups", () =>
    expect(classifyGroupClaim(["some-random-idp-group"])).toBe("unknown_groups"))
  it("empty array -> no_groups", () => expect(classifyGroupClaim([])).toBe("no_groups"))
  it("absent/undefined -> no_groups", () => expect(classifyGroupClaim(undefined)).toBe("no_groups"))
  it("mixed known + unknown -> unknown_groups (unknown must not hide behind a valid match)", () =>
    expect(classifyGroupClaim(["developer", "some-random-group"])).toBe("unknown_groups"))
})

describe("getRoleFromGroups", () => {
  it("known group resolves to its role", () => expect(getRoleFromGroups(["developer"])).toBe("developer"))
  it("unrecognized groups sanitize to empty and fail closed to guest", () => {
    const sanitized = sanitizeGroups(["some-random-idp-group"])
    expect(getRoleFromGroups(sanitized)).toBe("guest")
  })
  it("empty/absent groups resolve to guest", () => expect(getRoleFromGroups([])).toBe("guest"))
  it("mixed known + unknown: the known role still wins", () => {
    const sanitized = sanitizeGroups(["developer", "some-random-group"])
    expect(getRoleFromGroups(sanitized)).toBe("developer")
  })
  it("cluster-admin outranks a lower role present in the same list", () =>
    expect(getRoleFromGroups(["developer", "cluster-admin"])).toBe("cluster-admin"))
})
