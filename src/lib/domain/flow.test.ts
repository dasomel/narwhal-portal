import { describe, expect, it } from "vitest"

import { clampFlowLimit, FLOW_VERDICTS, normalizeFlow, normalizeFlowVerdict, type FlowScope } from "./flow"

const scope: FlowScope = { all: false, namespaces: new Set(["tenant-a"]) }
const redacted = { redacted: true, namespace: null, workload: null, pod: null }
const flow = () => ({
  uuid: "abc-123", verdict: "FORWARDED", time: "2024-02-29T12:34:56.123+09:00",
  source: { namespace: "tenant-a", pod_name: "pod-a", workloads: [{ name: "app-a", kind: "Deployment" }] },
  destination: { namespace: "tenant-b", pod_name: "secret-pod", workloads: [{ name: "secret-app" }], labels: ["secret-label"] },
})
const normalize = (raw: unknown, inputScope: unknown = scope) => normalizeFlow(raw, inputScope as FlowScope)
const throwing = () => { throw new Error("untrusted") }
const proxy = new Proxy({}, { get: throwing, getOwnPropertyDescriptor: throwing, getPrototypeOf: throwing })

describe("flow normalization", () => {
  it("exports the closed verdict vocabulary", () => {
    expect(FLOW_VERDICTS).toEqual(["forwarded", "dropped", "audit", "unknown"])
  })

  it.each([
    ["FORWARDED", "forwarded"], ["DROPPED", "dropped"], ["AUDIT", "audit"],
    ...["ERROR", "REDIRECTED", "TRACED", "TRANSLATED", "VERDICT_UNKNOWN", "forwarded", "dropped", "audit", "", "constructor", "__proto__", 1, NaN, null, undefined, true, {}, []].map((value) => [value, "unknown"]),
  ])("normalizes verdict %s to %s", (value, expected) => {
    expect(normalizeFlowVerdict(value)).toBe(expected)
  })

  it.each([
    ["tenant-a", "tenant-b", true], ["tenant-b", "tenant-a", true],
    ["tenant-a", "tenant-a", true], ["tenant-b", "tenant-c", false],
    ["", "", false], [undefined, null, false], ["", "tenant-a", true],
    ["tenant-a-extra", "*", false],
  ])("checks visibility %s / %s", (source, destination, expected) => {
    expect(normalize({ uuid: "id", source: { namespace: source }, destination: { namespace: destination } }) !== null).toBe(expected)
  })

  it.each(["true", 1, null, undefined, NaN, {}])("requires all === true: %s", (all) => {
    expect(normalize({ uuid: "id" }, { all, namespaces: new Set() })).toBeNull()
  })

  it.each([[], {}, null, undefined, "tenant-a"])("requires a real Set: %s", (namespaces) => {
    expect(normalize(flow(), { all: false, namespaces })).toBeNull()
  })

  it.each([
    ["string all", { all: "true", namespaces: new Set(["tenant-a"]) }],
    ["numeric all", { all: 1, namespaces: new Set(["tenant-a"]) }],
    ["array namespaces", { all: false, namespaces: ["tenant-b"] }],
    ["Set-like object", { all: false, namespaces: { has: () => true } }],
    ["overridden Set subclass", { all: false, namespaces: new (class extends Set<string> {
      has() { return true }
    })(["tenant-a"]) }],
    ["Proxy-wrapped Set", { all: false, namespaces: new Proxy(new Set(["tenant-b"]), {}) }],
    ["accessor all", { get all() { return true }, namespaces: new Set() }],
    ["accessor namespaces", { all: false, get namespaces() { return new Set(["tenant-b"]) } }],
    ["prototype scope", Object.assign(Object.create({}), { all: true, namespaces: new Set() })],
  ])("fails closed for forged scope: %s", (_label, forgedScope) => {
    const raw = { ...flow(), source: { namespace: "tenant-b" }, destination: { namespace: "tenant-c" } }
    expect(normalize(raw, forgedScope)).toBeNull()
  })

  it("supports all scope and redacts world endpoints in tenant scope", () => {
    expect(normalize({ uuid: "id" }, { all: true, namespaces: null })?.source.redacted).toBe(false)
    expect(normalize({ ...flow(), destination: { namespace: "" } })?.destination).toEqual(redacted)
  })

  it("does not leak out-of-scope identities", () => {
    const result = normalize(flow())
    expect(result?.destination).toEqual(redacted)
    expect(result?.source).toEqual({ redacted: false, namespace: "tenant-a", pod: "pod-a", workload: "app-a" })
    for (const secret of ["tenant-b", "secret-pod", "secret-app", "secret-label"]) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it("preserves policy counts while hiding identities", () => {
    const raw = { ...flow(),
      egress_allowed_by: [{ name: "allowed", namespace: "tenant-a" }, { name: "secret-policy", namespace: "tenant-b" }],
      ingress_denied_by: [{ name: "cluster-policy" }, { name: "empty-policy", namespace: "" }],
    }
    expect(normalize(raw)?.policies).toEqual([
      { direction: "egress", effect: "allowed", name: "allowed", namespace: "tenant-a", redacted: false },
      { direction: "egress", effect: "allowed", name: null, namespace: null, redacted: true },
      { direction: "ingress", effect: "denied", name: null, namespace: null, redacted: true },
      { direction: "ingress", effect: "denied", name: null, namespace: null, redacted: true },
    ])
    expect(JSON.stringify(normalize(raw))).not.toContain("secret-policy")
    expect(JSON.stringify(normalize(raw))).not.toContain("cluster-policy")
    expect(normalize(raw, { all: true })?.policies.every((policy) => !policy.redacted)).toBe(true)
  })

  it.each([null, [], "id", 1, undefined])("rejects malformed top-level %s", (raw) => {
    expect(normalize(raw)).toBeNull()
  })

  it.each([undefined, null, 1, {}, "", "a_b", "a\n", "a".repeat(129)])("rejects uuid %s", (uuid) => {
    expect(normalize({ ...flow(), uuid })).toBeNull()
  })

  it.each([undefined, null, 1, {}, "", "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(32) + "\n"])("rejects trace %s", (trace_id) => {
    expect(normalize({ ...flow(), trace_context: { parent: { trace_id } } })?.traceId).toBeNull()
  })

  it("accepts validated identity fields and all policy directions", () => {
    const trace_id = "0123456789abcdef0123456789abcdef"
    const raw = { ...flow(), uuid: "a".repeat(128), verdict: "DROPPED", drop_reason_desc: "POLICY_DENIED",
      trace_context: { parent: { trace_id } }, egress_denied_by: [{ name: "deny", namespace: "tenant-a" }],
      ingress_allowed_by: [{ name: "allow", namespace: "tenant-a" }],
    }
    expect(normalize(raw)).toMatchObject({ traceId: trace_id, dropReason: "POLICY_DENIED", time: raw.time })
    expect(normalize(raw)?.policies.map((policy) => [policy.direction, policy.effect])).toEqual([["egress", "denied"], ["ingress", "allowed"]])
  })

  it.each([undefined, null, 1, {}, "", "policy", "A-B", "A".repeat(65), "A\n"])("rejects drop reason %s", (drop_reason_desc) => {
    expect(normalize({ ...flow(), verdict: "DROPPED", drop_reason_desc })?.dropReason).toBeNull()
  })

  it.each(["FORWARDED", "AUDIT", "ERROR", undefined])("hides drop reason for %s", (verdict) => {
    expect(normalize({ ...flow(), verdict, drop_reason_desc: "POLICY_DENIED" })?.dropReason).toBeNull()
  })

  it.each([
    "2024-02-29T23:59:59Z", "2000-02-29T00:00:00-23:59", "2023-04-30T00:00:00.123456789+00:00",
  ])("accepts strict time %s", (time) => {
    expect(normalize({ ...flow(), time })?.time).toBe(time)
  })

  it.each([
    undefined, null, 1, {}, "", "2023-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2024-04-31T00:00:00Z",
    "2024-00-01T00:00:00Z", "2024-13-01T00:00:00Z", "2024-01-00T00:00:00Z", "2024-01-32T00:00:00Z",
    "2024-01-01T24:00:00Z", "2024-01-01T00:60:00Z", "2024-01-01T00:00:60Z",
    "2024-01-01T00:00:00+24:00", "2024-01-01T00:00:00+00:60", "2024-01-01T00:00:00",
    "2024-01-01T00:00:00z", "2024-01-01T00:00:00Z\n",
  ])("rejects time %s", (time) => {
    expect(normalize({ ...flow(), time })?.time).toBeNull()
  })

  it("contains throwing getters, revoked proxies, and nested hostile inputs", () => {
    expect(normalize({ ...flow(), get uuid() { return throwing() } })).toBeNull()
    expect(normalize({ ...flow(), get verdict() { return throwing() } })?.verdict).toBe("unknown")
    expect(normalize({ ...flow(), get source() { return throwing() } })).toBeNull()
    expect(normalize(flow(), { get all() { return throwing() }, namespaces: new Set() })).toBeNull()
    expect(normalize(proxy)).toBeNull()
    expect(normalizeFlowVerdict(proxy)).toBe("unknown")
    expect(normalize(flow(), proxy)).toBeNull()
    expect(normalize(flow(), { all: false, namespaces: proxy })).toBeNull()
    expect(normalize(flow(), { all: false, namespaces: new Proxy(new Set(["tenant-a"]), {}) })).toBeNull()
    const fakeSet = new Set<string>()
    fakeSet.has = () => true
    expect(normalize(flow(), { all: false, namespaces: fakeSet })).toBeNull()
    expect(normalize({ ...flow(), source: proxy })).toBeNull()
    expect(normalize({ ...flow(), trace_context: proxy })?.traceId).toBeNull()
    expect(normalize({ ...flow(), egress_allowed_by: [proxy] })?.policies[0]).toMatchObject({ redacted: true, name: null })
    expect(normalize({ ...flow(), source: { namespace: "tenant-a", workloads: new Proxy([], { get: throwing }) } })).toBeNull()
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(normalize(revoked.proxy)).toBeNull()
    expect(normalizeFlowVerdict(revoked.proxy)).toBe("unknown")
  })

  it("ignores inherited fields and treats prototype keys as literal namespaces", () => {
    expect(normalize(Object.create(flow()))).toBeNull()
    expect(normalize(flow(), Object.create({ all: true, namespaces: new Set(["tenant-a"]) }))).toBeNull()
    expect(normalize({ ...flow(), source: Object.create({ namespace: "tenant-a" }) })).toBeNull()
    for (const namespace of ["__proto__", "constructor"]) {
      const raw = JSON.parse(`{"uuid":"id","source":{"namespace":"${namespace}"},"__proto__":{"verdict":"FORWARDED"}}`)
      expect(normalize(raw)).toBeNull()
      expect(normalize(raw, { all: false, namespaces: new Set([namespace]) })?.verdict).toBe("unknown")
    }
  })
})

describe("clampFlowLimit", () => {
  it.each([undefined, null, NaN, Infinity, -Infinity, "10", {}, [], true, 0, -1, 1.5])("defaults invalid %s", (input) => {
    expect(clampFlowLimit(input)).toBe(100)
  })

  it.each([
    [5001, { max: 5000 }, 1000],
    [null, { default: 5000, max: 5000 }, 1000],
    [5001, { max: NaN }, 1000],
    [null, { default: NaN, max: NaN }, 100],
    [null, { default: 101, max: 50 }, 50],
    [null, { default: Infinity, max: 50 }, 50],
  ])("hardens limit %s with %s to %s", (input, opts, expected) => {
    expect(clampFlowLimit(input, opts)).toBe(expected)
  })

  it("clamps positive integers and validates options", () => {
    expect(clampFlowLimit(1)).toBe(1)
    expect(clampFlowLimit(1001)).toBe(1000)
    expect(clampFlowLimit(null, { default: 20, max: 50 })).toBe(20)
    expect(clampFlowLimit(null, { default: 100, max: 50 })).toBe(50)
    expect(clampFlowLimit(100, { max: 50 })).toBe(50)
    expect(clampFlowLimit(null, { default: NaN, max: Infinity })).toBe(100)
    expect(clampFlowLimit(proxy)).toBe(100)
    expect(clampFlowLimit(null, proxy)).toBe(100)
    expect(clampFlowLimit(null, { get default() { return throwing() }, get max() { return throwing() } })).toBe(100)
    expect(clampFlowLimit(null, Object.create({ default: 1, max: 1 }))).toBe(100)
  })
})
