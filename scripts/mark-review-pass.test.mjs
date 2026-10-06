// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
import { describe, expect, it } from "vitest"
import { planStatus } from "./mark-review-pass.mjs"

const sha = "abcdef0123456789abcdef0123456789abcdef01"
const pr = (o = {}) => ({ headRefOid: sha, isDraft: false, state: "OPEN", ...o })

describe("planStatus", () => {
  it("accepts when the reviewed SHA equals the head", () => {
    expect(planStatus(pr(), sha)).toEqual({ ok: true, sha, reason: "will mark abcdef0" })
  })
  it("refuses when the head differs from the reviewed SHA, naming both", () => {
    const other = "1234567" + "0".repeat(33)
    const r = planStatus(pr(), other)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(other)
    expect(r.reason).toContain(sha)
  })
  it("resolves a short prefix to the full head SHA", () => {
    expect(planStatus(pr(), "abcdef0").sha).toBe(sha)
    expect(planStatus(pr(), "ABCDEF0123").sha).toBe(sha)
  })
  it("refuses too-short, non-hex, or wrong prefixes", () => {
    expect(planStatus(pr(), "abcdef").ok).toBe(false)
    expect(planStatus(pr(), "abcdefg").ok).toBe(false)
    expect(planStatus(pr(), "abcdef1").ok).toBe(false)
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
