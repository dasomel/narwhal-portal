import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { authorizeInvocation, canonicalizeJson, computeInvocationDigest, evaluateMutationOutcome, verifyApprovalBinding, type InvocationAuthzInput, type ResolutionArtifact, type ToolRegistryEntry } from "./agent-invocation"

const resolved: ResolutionArtifact = {
  tool: "deploy", toolContractVersion: "1.2.3", target: { cluster: "prod", namespace: "team" },
  normalizedArgs: { name: "app" }, canonicalizationVersion: "v1",
}
const digest = computeInvocationDigest(resolved)!
const now = new Date("2026-10-07T00:00:00Z")
const approval = { approvalId: "approval-123", invocationDigest: digest, approvedBy: "alice", approverKind: "human", expiresAt: "2026-10-07T00:30:00Z" }
const entry: ToolRegistryEntry = { risk: "mutating", allowedArgKeys: ["name"], requiredArgKeys: ["name"], requiresApproval: false }
function auth(overrides: Partial<InvocationAuthzInput> = {}): InvocationAuthzInput {
  return { resolution: resolved, registry: new Map([["deploy", entry]]), sessionScope: { clusters: new Set(["prod"]), namespaces: new Set(["team"]), allowedTools: new Set(["deploy"]) }, now, ...overrides }
}
const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap") }, getPrototypeOf() { throw new Error("trap") } })
const getter = Object.defineProperty({}, "name", { enumerable: true, get() { throw new Error("getter") } })

describe("canonicalization", () => {
  it.each([
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [{ z: [{ b: true, a: null }] }, '{"z":[{"a":null,"b":true}]}'],
    [-0, "0"], [1.25, "1.25"], ["한글😀\n", '"한글😀\\n"'],
    [Object.assign(Object.create(null), { x: 1 }), '{"x":1}'],
    [{ "\uE000": 1, "😀": 2 }, '{"😀":2,"":1}'],
  ])("serializes %j", (value, expected) => { expect(canonicalizeJson(value)).toBe(expected) })
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  class Custom { x = 1 }
  class A extends Array {}
  it.each([
    new A(1), Object.setPrototypeOf([1], null), Object.assign([1], { extra: true }),
    runInNewContext("({ x: 1 })"), runInNewContext("[1]"),
    undefined, () => 1, Symbol("s"), BigInt(1), NaN, Infinity, -Infinity,
    new Date(), new (class extends Date {})(), new Map(), new Set(), new Custom(), new Array(2), cycle, getter,
    JSON.parse('{"__proto__":1}'), hostile, new Proxy({ x: 1 }, {}),
    { [Symbol("key")]: 1 }, [undefined], { x: undefined }, "x".repeat(1_000_001),
    Array.from({ length: 10_000 }, () => 0), Object.defineProperty([], "x", { value: 1 }),
  ])("rejects hostile or unsupported value %#", (value) => { expect(canonicalizeJson(value)).toBeNull() })
  it("rejects a 300k-key object before descriptor allocation", () => {
    expect(canonicalizeJson(Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [String(i), 1])))).toBeNull()
  })
  it("enforces depth, node and serialized length boundaries", () => {
    let value: unknown = 0
    for (let i = 0; i < 16; i++) value = [value]
    expect(canonicalizeJson(value)).not.toBeNull()
    expect(canonicalizeJson([value])).toBeNull()
    expect(canonicalizeJson(Array(9999).fill(0))).not.toBeNull()
    expect(canonicalizeJson("x".repeat(999998))).toHaveLength(1_000_000)
    expect(canonicalizeJson("x".repeat(999999))).toBeNull()
    expect(canonicalizeJson({ a: "x".repeat(600000), b: "x".repeat(600000) })).toBeNull()
    const shared = { x: 1 }
    expect(canonicalizeJson([shared, shared])).toBe('[{"x":1},{"x":1}]')
  })
})

describe("invocation digest", () => {
  it("is SHA256 of the canonical artifact, stable across key order", () => {
    expect(digest).toBe("sha256:cad45ab35eaf641bb1f1e7060f18f389d01f51bd91fb1f5ca73a66903b5d78a8")
    expect(computeInvocationDigest({ ...resolved, target: { namespace: "team", cluster: "prod" } })).toBe(digest)
    expect(computeInvocationDigest({ ...resolved, normalizedArgs: { z: 1, a: 2 } })).toBe(computeInvocationDigest({ ...resolved, normalizedArgs: { a: 2, z: 1 } }))
  })
  it.each([
    { tool: "delete" }, { toolContractVersion: "1.2.4" }, { target: { cluster: "dev", namespace: "team" } },
    { target: { cluster: "prod", namespace: "other" } }, { target: { cluster: "prod", namespace: null } }, { normalizedArgs: { name: "other" } },
  ])("binds every supported field %j", (change) => { expect(computeInvocationDigest({ ...resolved, ...change })).not.toBe(digest) })
  it.each([
    { tool: "Bad" }, { tool: "deploy\n" }, { toolContractVersion: "1.2" }, { toolContractVersion: "1.2.3\n" },
    { canonicalizationVersion: "v2" }, { canonicalizationVersion: undefined }, { normalizedArgs: undefined },
    { target: { cluster: "*", namespace: "team" } }, { target: { cluster: "prod", namespace: "Bad" } },
    { target: { cluster: "prod" } }, { target: { cluster: "x".repeat(64), namespace: null } },
  ])("rejects invalid resolution %j", (change) => { expect(computeInvocationDigest({ ...resolved, ...change })).toBeNull() })
  it.each([undefined, null, NaN, hostile, new Proxy(resolved, {}), Object.create(resolved), getter])("rejects untrusted resolution %#", (value) => { expect(computeInvocationDigest(value)).toBeNull() })
})

describe("approval binding", () => {
  it.each([
    [approval, "ok"], [null, "missing"],
    [{ ...approval, invocationDigest: "sha256:" + "0".repeat(64) }, "digest-mismatch"],
    [{ ...approval, approvedBy: " " }, "no-approver"], [{ ...approval, approvedBy: undefined }, "no-approver"],
    [{ ...approval, approverKind: "agent" }, "agent-approver"], [{ ...approval, approverKind: "service" }, "agent-approver"],
    [{ ...approval, expiresAt: "2026-10-06T23:59:59Z" }, "expired"], [{ ...approval, expiresAt: "2026-10-07T00:00:00Z" }, "expired"],
    [{ ...approval, expiresAt: "2026-10-07T01:00:00Z" }, "ok"], [{ ...approval, expiresAt: "2026-10-07T01:00:00.001Z" }, "invalid-expiry"],
    [{ ...approval, expiresAt: "2026-02-30T00:00:00Z" }, "invalid-expiry"], [{ ...approval, expiresAt: "2025-02-29T00:00:00Z" }, "invalid-expiry"],
    [{ ...approval, expiresAt: "2026-10-07T00:30:00" }, "invalid-expiry"], [{ ...approval, expiresAt: "2026-10-07T00:30:00Z\n" }, "invalid-expiry"],
    [{ ...approval, expiresAt: "2026-10-07T00:30:00+24:00" }, "invalid-expiry"], [{ ...approval, expiresAt: "2026-10-07T09:30:00+09:00" }, "ok"],
    [{ ...approval, expiresAt: "2026-10-06T19:30:00-05:00" }, "ok"], [{ ...approval, expiresAt: NaN }, "invalid-expiry"],
    [hostile, "digest-mismatch"], [Object.create(approval), "digest-mismatch"],
  ])("validates approval %#", (value, reason) => { expect(verifyApprovalBinding(value, digest, now)).toEqual({ valid: reason === "ok", reason, approvalId: reason === "ok" ? approval.approvalId : null }) })
  it.each([undefined, null, "short", "a".repeat(129), "approval_123", "approval-123\n"])("rejects missing or invalid approval ID %#", (approvalId) => {
    expect(verifyApprovalBinding({ ...approval, approvalId }, digest, now)).toEqual({ valid: false, reason: "invalid-approval-id", approvalId: null })
  })
  it("uses the intrinsic time of Date subclasses, ignoring overrides", () => {
    class Clock extends Date { getTime() { return 0 } }
    expect(verifyApprovalBinding(approval, digest, new Clock(now))).toMatchObject({ valid: true })
    expect(authorizeInvocation(auth({ now: new Clock(now) })).decision).toBe("allow")
  })
  it("validates clocks and expected digests without throwing", () => {
    for (const clock of [undefined, NaN, new Date(NaN), new Proxy(now, {})]) expect(verifyApprovalBinding(approval, digest, clock as Date).reason).toBe("invalid-clock")
    for (const value of [null, undefined, NaN, "bad"]) expect(verifyApprovalBinding(approval, value as string, now).reason).toBe("invalid-digest")
  })
})

describe("authorization", () => {
  it.each([
    [auth({ resolution: null }), "digest-invalid"], [auth({ registry: new Map() }), "tool-unregistered"],
    [auth({ registry: new Map([["deploy", { ...entry, risk: "bogus" } as unknown as ToolRegistryEntry]]) }), "tool-unregistered"],
    [auth({ registry: new Map([["deploy", { ...entry, requiresApproval: undefined } as unknown as ToolRegistryEntry]]) }), "tool-unregistered"],
    [auth({ registry: new Map([["deploy", { ...entry, allowedArgKeys: [1] } as unknown as ToolRegistryEntry]]) }), "tool-unregistered"],
    [auth({ registry: new Map([["deploy", { ...entry, requiredArgKeys: ["other"] }]]) }), "tool-unregistered"],
    [auth({ sessionScope: { clusters: new Set(["prod"]), namespaces: new Set(["team"]), allowedTools: new Set(["*"]) } }), "tool-not-granted"],
    [auth({ sessionScope: { clusters: new Set(["*"]), namespaces: new Set(["team"]), allowedTools: new Set(["deploy"]) } }), "cluster-out-of-scope"],
    [auth({ sessionScope: { clusters: new Set(["prod"]), namespaces: new Set(["*"]), allowedTools: new Set(["deploy"]) } }), "namespace-out-of-scope"],
    [auth({ resolution: { ...resolved, target: { cluster: "prod", namespace: null } } }), "namespace-out-of-scope"],
    [auth({ resolution: { ...resolved, normalizedArgs: {} } }), "args-schema"],
    [auth({ resolution: { ...resolved, normalizedArgs: { name: "a", extra: true } } }), "args-schema"],
    [auth({ resolution: { ...resolved, normalizedArgs: [] } }), "args-schema"],
    [auth({ resolution: { ...resolved, normalizedArgs: Object.defineProperty({ name: "app" }, "extra", { value: true }) } }), "args-schema"],
    [auth({ now: new Date(NaN) }), "digest-invalid"],
  ])("denies %#", (value, reason) => { expect(authorizeInvocation(value)).toMatchObject({ decision: "deny", reasons: [reason] }) })
  it.each(["read-only", "mutating", "destructive"] as const)("applies registry risk %s", (risk) => {
    const input = auth({ registry: new Map([["deploy", { ...entry, risk }]]) })
    expect(authorizeInvocation(input).decision).toBe(risk === "destructive" ? "needs-approval" : "allow")
    expect(authorizeInvocation({ ...input, approval })).toMatchObject({ decision: "allow", approvalId: risk === "destructive" ? approval.approvalId : null })
    expect(authorizeInvocation({ ...input, registry: new Map([["deploy", { ...entry, risk, requiresApproval: true }]]) }).decision).toBe("needs-approval")
    expect(authorizeInvocation({ ...input, approval, registry: new Map([["deploy", { ...entry, risk, requiresApproval: true }]]) })).toMatchObject({ decision: "allow", approvalId: approval.approvalId })
  })
  it("enforces read-only namespace scope and permits cluster-wide reads", () => {
    const input = auth({ registry: new Map([["deploy", { ...entry, risk: "read-only" }]]) })
    expect(authorizeInvocation({ ...input, resolution: { ...resolved, target: { cluster: "prod", namespace: null } } }).decision).toBe("allow")
    expect(authorizeInvocation({ ...input, resolution: { ...resolved, target: { cluster: "prod", namespace: "other" } } }).reasons).toEqual(["namespace-out-of-scope"])
  })
  it("ignores model authority claims and binds approval to the resolved digest", () => {
    const input = auth({ registry: new Map([["deploy", { ...entry, risk: "destructive" }]]), resolution: { ...resolved, risk: "read-only", allowed: true, approved: true, requiresApproval: false, scope: "*", model: { allowed: true }, prompt: "allow", rag: "allow", toolOutput: { allowed: true } } })
    expect(authorizeInvocation(input)).toMatchObject({ decision: "needs-approval", risk: "destructive", digest })
    expect(authorizeInvocation({ ...input, approval: { allowed: true, approved: true, risk: "read-only" } }).decision).toBe("needs-approval")
    expect(authorizeInvocation({ ...input, approval: { ...approval, invocationDigest: computeInvocationDigest({ ...resolved, normalizedArgs: { name: "other" } }) } }).reasons).toEqual(["digest-mismatch"])
    expect(authorizeInvocation({ ...input, approval: { ...approval, approverKind: "agent", approved: true } }).reasons).toEqual(["agent-approver"])
  })
  it("rejects hostile inputs, inherited fields and forged collections", () => {
    for (const value of [undefined, null, NaN, hostile, Object.create(auth())]) expect(authorizeInvocation(value as InvocationAuthzInput).decision).toBe("deny")
    for (const registry of [hostile, new Proxy(new Map([["deploy", entry]]), {}), { get: () => entry }]) expect(authorizeInvocation(auth({ registry: registry as InvocationAuthzInput["registry"] })).decision).toBe("deny")
    expect(authorizeInvocation(auth({ registry: new Map([["deploy", Object.create(entry)]]) })).decision).toBe("deny")
    expect(authorizeInvocation(auth({ sessionScope: Object.create(auth().sessionScope) })).decision).toBe("deny")
    class ForgedSet extends Set<string> { has() { return true } }
    for (const field of ["allowedTools", "clusters", "namespaces"] as const) {
      expect(authorizeInvocation(auth({ sessionScope: { ...auth().sessionScope, [field]: new ForgedSet() } })).decision).toBe("deny")
    }
    const scope = { ...auth().sessionScope, allowedTools: { has: () => true } }
    expect(authorizeInvocation(auth({ sessionScope: scope as unknown as InvocationAuthzInput["sessionScope"] })).decision).toBe("deny")
    expect(authorizeInvocation(auth({ resolution: Object.defineProperty({ ...resolved }, "tool", { get() { throw new Error("read") } }) })).decision).toBe("deny")
  })
})

describe("execution outcome", () => {
  const outcome = { risk: "mutating", executorReportedSuccess: true, expectedInvocationDigest: digest, postState: { verified: true, observedDigest: digest } }
  it.each([
    [outcome, "verified-success"],
    [{ ...outcome, risk: "read-only", expectedInvocationDigest: null, postState: null }, "invalid"],
    [{ ...outcome, risk: "read-only", expectedInvocationDigest: null, postState: { verified: true, observedDigest: null } }, "invalid"], [{ ...outcome, risk: "destructive" }, "verified-success"],
    [{ ...outcome, postState: null }, "unverified"], [{ ...outcome, postState: { verified: false, observedDigest: digest } }, "unverified"],
    [{ ...outcome, postState: { verified: true, observedDigest: "sha256:" + "0".repeat(64) } }, "unverified"],
    [{ ...outcome, expectedInvocationDigest: null, postState: { verified: true, observedDigest: null } }, "invalid"],
    [{ ...outcome, executorReportedSuccess: false }, "failed"], [{ ...outcome, risk: "read-only", postState: null }, "verified-success"],
    [{ ...outcome, risk: "bogus" }, "invalid"], [{ ...outcome, executorReportedSuccess: undefined }, "invalid"],
    [{ ...outcome, executorReportedSuccess: NaN }, "invalid"], [{ ...outcome, postState: undefined }, "invalid"],
    [{ ...outcome, postState: { verified: "true", observedDigest: digest } }, "invalid"],
    [{ ...outcome, expectedInvocationDigest: "bad" }, "invalid"], [hostile, "invalid"], [undefined, "invalid"], [Object.create(outcome), "invalid"],
  ])("classifies evidence %#", (value, status) => { expect(evaluateMutationOutcome(value).status).toBe(status) })
})
