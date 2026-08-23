import { describe, expect, it } from "vitest"
import { isValidEventActor, isValidEventResource } from "./event-envelope"

describe("isValidEventActor", () => {
  it("accepts a minimal valid actor", () => expect(isValidEventActor({ id: "alice", type: "user" })).toBe(true))
  it("accepts an optional displayName", () =>
    expect(isValidEventActor({ id: "svc", type: "service", displayName: "Sync Bot" })).toBe(true))
  it("rejects a missing id", () => expect(isValidEventActor({ type: "user" })).toBe(false))
  it("rejects an empty id", () => expect(isValidEventActor({ id: "", type: "user" })).toBe(false))
  it("rejects an unknown type", () => expect(isValidEventActor({ id: "x", type: "robot" })).toBe(false))
  it("rejects a non-string displayName", () =>
    expect(isValidEventActor({ id: "x", type: "user", displayName: 5 })).toBe(false))
  it("rejects non-objects", () => {
    expect(isValidEventActor(null)).toBe(false)
    expect(isValidEventActor("alice")).toBe(false)
  })
})

describe("isValidEventResource", () => {
  it("accepts an empty object — every field is optional", () => expect(isValidEventResource({})).toBe(true))
  it("accepts a fully populated resource", () =>
    expect(
      isValidEventResource({
        cluster: "prod",
        namespace: "team-a",
        kind: "Application",
        name: "api",
        workload: "api-deploy",
      }),
    ).toBe(true))
  it("rejects a non-string field", () => expect(isValidEventResource({ namespace: 5 })).toBe(false))
  it("rejects non-objects", () => {
    expect(isValidEventResource(null)).toBe(false)
    expect(isValidEventResource("team-a")).toBe(false)
  })
})
