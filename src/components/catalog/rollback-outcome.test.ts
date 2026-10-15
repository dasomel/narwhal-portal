import { describe, expect, it } from "vitest"
import { rollbackErrorMessage } from "./rollback-outcome"

const res = (body: string, status = 502) => new Response(body, { status })

describe("rollbackErrorMessage (#47)", () => {
  it.each(["unknown", "rejected"])("shows the server text for outcome %s", async (outcome) => {
    const r = res(JSON.stringify({ outcome, error: "verify status before retrying" }))
    expect(await rollbackErrorMessage(r)).toBe("verify status before retrying")
  })
  it.each([
    ["other outcome", JSON.stringify({ outcome: "x", error: "secret" })],
    ["no outcome", JSON.stringify({ error: "boom" })],
    ["non-string error", JSON.stringify({ outcome: "unknown", error: 5 })],
    ["empty error", JSON.stringify({ outcome: "unknown", error: "" })],
    ["non-JSON", "<html>"],
    ["null", "null"],
    ["empty", ""],
  ])("falls back to the null for %s", async (_l, body) => {
    expect(await rollbackErrorMessage(res(body))).toBeNull()
  })
})
