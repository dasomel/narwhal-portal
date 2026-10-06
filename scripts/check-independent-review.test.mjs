// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
import { describe, expect, it } from "vitest"
import { evaluate, parseConcatenatedJson } from "./check-independent-review.mjs"

const commit = (date, sha = "abcdef1234") => ({ sha, commit: { committer: { date } } })
const labeled = (at, login = "reviewer") => ({
  event: "labeled",
  label: { name: "review:pass" },
  created_at: at,
  actor: { login },
})
const unlabeled = (at) => ({ event: "unlabeled", label: { name: "review:pass" }, created_at: at })
const pr = (over = {}) => ({ draft: false, labels: [{ name: "review:pass" }], ...over })

describe("independent-review evaluate", () => {
  it("passes when label postdates the newest commit", () => {
    const r = evaluate({
      pr: pr(),
      commits: [commit("2026-01-01T10:00:00Z"), commit("2026-01-01T11:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z", "alice")],
    })
    expect(r.ok).toBe(true)
    expect(r.reason).toContain("alice")
  })

  it("fails when the label is not on the PR", () => {
    const r = evaluate({
      pr: pr({ labels: [] }),
      commits: [commit("2026-01-01T10:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z")],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("not on the PR")
  })

  it("fails when the label is older than the newest commit (stale)", () => {
    const r = evaluate({
      pr: pr(),
      commits: [commit("2026-01-01T13:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z")],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("stale")
  })

  it("fails on an exact tie (strict comparison)", () => {
    const r = evaluate({
      pr: pr(),
      commits: [commit("2026-01-01T12:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z")],
    })
    expect(r.ok).toBe(false)
  })

  it("uses the latest labeled event after remove + re-add following a push", () => {
    const base = {
      pr: pr(),
      commits: [commit("2026-01-01T10:00:00Z"), commit("2026-01-01T13:00:00Z")],
    }
    const staleOnly = evaluate({ ...base, timeline: [labeled("2026-01-01T11:00:00Z")] })
    expect(staleOnly.ok).toBe(false)
    const readded = evaluate({
      ...base,
      timeline: [
        labeled("2026-01-01T11:00:00Z"),
        unlabeled("2026-01-01T13:30:00Z"),
        labeled("2026-01-01T14:00:00Z", "bob"),
      ],
    })
    expect(readded.ok).toBe(true)
    expect(readded.reason).toContain("bob")
  })

  it("fails on a draft PR even with a fresh label", () => {
    const r = evaluate({
      pr: pr({ draft: true }),
      commits: [commit("2026-01-01T10:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z")],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("draft")
  })

  it("fails when a force-push happened after the label", () => {
    const r = evaluate({
      pr: pr(),
      commits: [commit("2026-01-01T10:00:00Z")],
      timeline: [labeled("2026-01-01T12:00:00Z"), { event: "head_ref_force_pushed", created_at: "2026-01-01T12:30:00Z" }],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("force-push")
  })

  it("fails closed on empty or missing timeline / commits / bad dates", () => {
    const c = [commit("2026-01-01T10:00:00Z")]
    expect(evaluate({ pr: pr(), commits: c, timeline: [] }).ok).toBe(false)
    expect(evaluate({ pr: pr(), commits: c, timeline: undefined }).ok).toBe(false)
    expect(evaluate({ pr: pr(), commits: [], timeline: [labeled("2026-01-01T12:00:00Z")] }).ok).toBe(false)
    expect(evaluate({ pr: pr(), commits: c, timeline: [{ event: "commented" }] }).ok).toBe(false)
    expect(evaluate({ pr: pr(), commits: [commit("garbage")], timeline: [labeled("2026-01-01T12:00:00Z")] }).ok).toBe(false)
    expect(evaluate({ pr: undefined, commits: c, timeline: [] }).ok).toBe(false)
  })
})

describe("parseConcatenatedJson", () => {
  it("flattens concatenated pages and ignores brackets inside strings", () => {
    const text = '[{"a":"]["},{"a":2}]\n[{"a":"\\"}]"}]'
    expect(parseConcatenatedJson(text)).toEqual([{ a: "][" }, { a: 2 }, { a: '"}]' }])
  })
  it("handles a single array and rejects truncated input", () => {
    expect(parseConcatenatedJson("[1,2]")).toEqual([1, 2])
    expect(() => parseConcatenatedJson("[1,")).toThrow()
  })
})
