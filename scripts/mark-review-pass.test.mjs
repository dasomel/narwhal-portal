// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
import { describe, expect, it } from "vitest"
import { planStatus, run } from "./mark-review-pass.mjs"

const sha = "abcdef0123456789abcdef0123456789abcdef01"
const pr = (o = {}) => ({ headRefOid: sha, isDraft: false, state: "OPEN", ...o })

describe("planStatus", () => {
  it("accepts an equal full SHA", () => {
    expect(planStatus(pr(), sha)).toEqual({ ok: true, sha, reason: "will mark abcdef0" })
  })
  it("accepts uppercase and lowercases it", () => {
    expect(planStatus(pr(), sha.toUpperCase()).sha).toBe(sha)
  })
  it("refuses a different head, naming both", () => {
    const other = "1".repeat(40)
    const r = planStatus(pr(), other)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(other)
    expect(r.reason).toContain(sha)
  })
  it("refuses prefixes, wrong lengths and non-hex", () => {
    expect(planStatus(pr(), sha.slice(0, 7)).ok).toBe(false)
    expect(planStatus(pr(), sha.slice(0, 39)).ok).toBe(false)
    expect(planStatus(pr(), sha + "0").ok).toBe(false)
    expect(planStatus(pr(), "g".repeat(40)).ok).toBe(false)
  })
  it("refuses a missing --sha", () => {
    expect(planStatus(pr(), undefined).ok).toBe(false)
    expect(planStatus(pr(), "").ok).toBe(false)
  })
  it("refuses draft, closed, merged, missing headRefOid, missing data", () => {
    expect(planStatus(pr({ isDraft: true }), sha).ok).toBe(false)
    expect(planStatus(pr({ state: "CLOSED" }), sha).ok).toBe(false)
    expect(planStatus(pr({ state: "MERGED" }), sha).ok).toBe(false)
    expect(planStatus(pr({ headRefOid: undefined }), sha).ok).toBe(false)
    expect(planStatus(undefined, sha).ok).toBe(false)
  })
})

describe("run", () => {
  const sink = () => {
    const l = { log: [], error: [] }
    return { l, out: { log: (m) => l.log.push(m), error: (m) => l.error.push(m) } }
  }
  const fakeGh = (heads, calls) => (args) => {
    calls.push(args)
    if (args[0] === "pr") return JSON.stringify(pr({ headRefOid: heads.shift() ?? heads.at(-1) }))
    return ""
  }

  it("posts the exact status payload on the full SHA, then reports success", () => {
    const calls = []
    const { l, out } = sink()
    expect(run(["7", "--sha", sha], fakeGh([sha, sha], calls), out)).toBe(0)
    const post = calls.filter((a) => a[0] === "api")
    expect(post).toEqual([
      [
        "api", `repos/dasomel/narwhal-portal/statuses/${sha}`,
        "-f", "state=success",
        "-f", "context=independent-review",
        "-f", "description=independent review PASS @abcdef0",
      ],
    ])
    expect(l.log.join()).toContain("PASS posted")
  })

  it("does not post when the head differs from the reviewed SHA", () => {
    const calls = []
    const { l, out } = sink()
    expect(run(["7", "--sha", sha], fakeGh(["2".repeat(40)], calls), out)).toBe(1)
    expect(calls.some((a) => a[0] === "api")).toBe(false)
    expect(l.log).toEqual([])
  })

  it("warns, exits non-zero and prints no success when the head moves after posting", () => {
    const { l, out } = sink()
    expect(run(["7", "--sha", sha], fakeGh([sha, "3".repeat(40)], []), out)).toBe(1)
    expect(l.log).toEqual([])
    expect(l.error.join()).toContain("WARNING")
  })

  it("turns gh failures into a one-line error, non-zero, no success", () => {
    const { l, out } = sink()
    const boom = () => { throw new Error("gh: boom\nstack...") }
    expect(run(["7", "--sha", sha], boom, out)).toBe(1)
    expect(l.log).toEqual([])
    expect(l.error).toEqual(["failed: gh: boom"])
  })

  it("returns 2 on bad usage", () => {
    expect(run(["x"], () => "", sink().out)).toBe(2)
  })
})
