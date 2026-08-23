import { describe, expect, it } from "vitest"
import { resolveNamespaceOwner } from "./namespace-ownership"

describe("resolveNamespaceOwner — non-admin", () => {
  it("rejects claiming a team the caller is not a member of (cross-team)", () => {
    const verdict = resolveNamespaceOwner("developer", ["team-a"], "team-b")
    expect(verdict).toEqual({ ok: false, status: 403, message: expect.stringContaining("team-b") })
  })

  it("allows claiming a team the caller belongs to", () => {
    const verdict = resolveNamespaceOwner("developer", ["team-a"], "team-a")
    expect(verdict).toEqual({ ok: true, team: "team-a" })
  })

  it("defaults to the caller's first team when no team is explicitly requested", () => {
    const verdict = resolveNamespaceOwner("developer", ["team-a", "team-b"], null)
    expect(verdict).toEqual({ ok: true, team: "team-a" })
  })

  it("rejects when the caller belongs to no team at all", () => {
    const verdict = resolveNamespaceOwner("developer", [], null)
    expect(verdict).toEqual({ ok: false, status: 400, message: expect.stringContaining("not a member of any team") })
  })
})

describe("resolveNamespaceOwner — cluster-admin", () => {
  it("allows claiming a team the admin does not belong to", () => {
    const verdict = resolveNamespaceOwner("cluster-admin", [], "team-b")
    expect(verdict).toEqual({ ok: true, team: "team-b" })
  })

  it("still requires SOME team — an admin claiming nothing with no teams of their own fails", () => {
    const verdict = resolveNamespaceOwner("cluster-admin", [], null)
    expect(verdict.ok).toBe(false)
  })
})
