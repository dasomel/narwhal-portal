import { describe, expect, it } from "vitest"
import {
  classifyPolicyState,
  evaluatePolicyException,
  POLICY_STATES,
  type PolicyException,
  type PolicyObservation,
  type PolicyState,
} from "./policy"

const now = new Date("2026-10-07T00:00:00.000Z")
const namespace = "payments"
const exception: PolicyException = {
  owner: "finance",
  reason: "Migration window",
  expiresAt: "2026-10-08T00:00:00.000Z",
  approvedBy: "reviewer",
  scope: { namespaces: [namespace] },
}
const observation: PolicyObservation = {
  ready: true,
  validationFailureAction: "Enforce",
  violationCount: 0,
  driftedFromGit: false,
  exception: null,
}

function malformedException(value: unknown): PolicyException {
  return value as PolicyException
}

function malformedObservation(value: unknown): PolicyObservation {
  return value as PolicyObservation
}

describe("policy exceptions", () => {
  it("activates a complete approved exception within its exact scope", () => {
    expect(evaluatePolicyException(exception, now, namespace)).toEqual({ active: true, reason: "ok" })
  })

  it.each([
    [-1, false, "expired"],
    [0, false, "expired"],
    [1, true, "ok"],
  ] as const)("checks expiry at now %+d milliseconds", (offset, active, reason) => {
    expect(evaluatePolicyException({ ...exception, expiresAt: new Date(now.getTime() + offset).toISOString() }, now, namespace))
      .toEqual({ active, reason })
  })

  it.each([
    [{ owner: " " }, "missing-owner"],
    [{ owner: null }, "missing-owner"],
    [{ reason: "\t" }, "missing-reason"],
    [{ expiresAt: null }, "missing-expiry"],
    [{ expiresAt: "" }, "missing-expiry"],
    [{ expiresAt: "yesterday-ish" }, "invalid-expiry"],
    [{ approvedBy: " " }, "unapproved"],
    [{ approvedBy: null }, "unapproved"],
    [{ scope: { namespaces: [] } }, "out-of-scope"],
    [{ scope: { namespaces: ["*"] } }, "out-of-scope"],
    [{ scope: { namespaces: ["other"] } }, "out-of-scope"],
    [{ scope: { namespaces: [null, 1, {}] } }, "out-of-scope"],
    [{ scope: { namespaces: ["Payments"] } }, "out-of-scope"],
    [{ scope: { namespaces: [" payments "] } }, "out-of-scope"],
    [{ scope: null }, "out-of-scope"],
    [{ scope: { namespaces: namespace } }, "out-of-scope"],
  ] as const)("denies malformed exception %j", (patch, reason) => {
    expect(evaluatePolicyException(malformedException({ ...exception, ...patch }), now, namespace))
      .toEqual({ active: false, reason })
  })

  it.each([
    "2099-12-31T00:00:00",
    "2099-12-31",
    "1",
    "Dec 31 2099",
    "2099-12-31T00:00:00+99:00",
  ])("rejects non-strict or unparseable expiry %s", (expiresAt) => {
    expect(evaluatePolicyException({ ...exception, expiresAt }, now, namespace))
      .toEqual({ active: false, reason: "invalid-expiry" })
  })

  it.each([
    "2026-02-30T00:00:00Z",
    "2026-02-31T00:00:00Z",
    "2026-04-31T23:59:59Z",
    "2025-02-29T00:00:00Z",
    "2028-02-29T24:00:00Z",
    "2028-02-29T00:60:00Z",
    "2028-02-29T00:00:60Z",
  ])("rejects impossible calendar dates and times %s", (expiresAt) => {
    expect(evaluatePolicyException({ ...exception, expiresAt }, now, namespace))
      .toEqual({ active: false, reason: "invalid-expiry" })
  })

  it.each([
    "2028-02-29T00:00:00Z",
    "2028-02-29T00:00:00.123Z",
  ])("accepts leap-day expiry with optional fractional seconds %s", (expiresAt) => {
    expect(evaluatePolicyException({ ...exception, expiresAt }, now, namespace))
      .toEqual({ active: true, reason: "ok" })
  })

  it.each([
    ["2026-10-07T00:00:00Z", false, "expired"],
    ["2026-10-07T09:00:00+09:00", false, "expired"],
    ["2026-10-06T19:00:00-05:00", false, "expired"],
    ["2026-10-07T09:00:00.001+09:00", true, "ok"],
  ] as const)("compares explicit-offset expiry %s by instant", (expiresAt, active, reason) => {
    expect(evaluatePolicyException({ ...exception, expiresAt }, now, namespace)).toEqual({ active, reason })
  })

  it("matches exact string scope entries even alongside malformed entries", () => {
    expect(evaluatePolicyException(malformedException({ ...exception, scope: { namespaces: [null, 1, {}, namespace] } }), now, namespace))
      .toEqual({ active: true, reason: "ok" })
  })

  it("rejects an invalid clock before approval and scope, after expiry validation", () => {
    expect(evaluatePolicyException(malformedException({ ...exception, approvedBy: null, scope: null }), new Date(NaN), namespace))
      .toEqual({ active: false, reason: "invalid-clock" })
    expect(evaluatePolicyException({ ...exception, expiresAt: "invalid" }, new Date(NaN), namespace))
      .toEqual({ active: false, reason: "invalid-expiry" })
  })

  it("returns only the first rejection in the contractual order", () => {
    const cases = [
      [{ owner: "", reason: "", expiresAt: null, approvedBy: null, scope: null }, "missing-owner"],
      [{ reason: "", expiresAt: null, approvedBy: null, scope: null }, "missing-reason"],
      [{ expiresAt: null, approvedBy: null, scope: null }, "missing-expiry"],
      [{ expiresAt: now.toISOString(), approvedBy: null, scope: null }, "expired"],
      [{ expiresAt: "invalid", approvedBy: null, scope: null }, "invalid-expiry"],
      [{ expiresAt: "invalid", scope: null }, "invalid-expiry"],
      [{ expiresAt: "invalid" }, "invalid-expiry"],
    ] as const
    for (const [patch, reason] of cases) {
      expect(evaluatePolicyException(malformedException({ ...exception, ...patch }), now, namespace))
        .toEqual({ active: false, reason })
    }
  })

  it("never throws on absent or malformed input and denies invalid clocks and targets", () => {
    for (const value of [null, undefined, false, 42, "exception", {}, []]) {
      expect(evaluatePolicyException(malformedException(value), now, namespace)).toEqual({ active: false, reason: "missing-owner" })
    }
    expect(evaluatePolicyException(exception, new Date(NaN), namespace)).toEqual({ active: false, reason: "invalid-clock" })
    expect(evaluatePolicyException({ ...exception, scope: { namespaces: ["*"] } }, now, "*"))
      .toEqual({ active: false, reason: "out-of-scope" })
    expect(evaluatePolicyException(exception, now, " ")).toEqual({ active: false, reason: "out-of-scope" })
  })
})

describe("policy state classification", () => {
  const precedence: [Partial<PolicyObservation>, PolicyState][] = [
    [{ ready: null, exception, driftedFromGit: true, violationCount: 2 }, "unknown"],
    [{ ready: false, exception, driftedFromGit: true, violationCount: 2 }, "not-ready"],
    [{ ready: false, validationFailureAction: "Unrecognised", exception }, "unknown"],
    [{ exception, driftedFromGit: true, violationCount: 2 }, "exception"],
    [{ driftedFromGit: true, violationCount: 2 }, "drifted"],
    [{ violationCount: 2 }, "violating"],
    [{ validationFailureAction: "Enforce" }, "enforced"],
    [{ validationFailureAction: "Audit" }, "audit"],
  ]

  it.each(precedence)("classifies %j as %s with first-match precedence", (patch, expected) => {
    expect(classifyPolicyState({ ...observation, ...patch }, now, namespace)).toBe(expected)
  })

  it("reaches every declared state", () => {
    const reached = precedence.map(([patch]) => classifyPolicyState({ ...observation, ...patch }, now, namespace))
    expect(new Set(reached)).toEqual(new Set(POLICY_STATES))
  })

  it("rejects missing or malformed observations before every lower precedence state", () => {
    const invalidFields = {
      ready: [null, undefined, "true", 1],
      driftedFromGit: [null, undefined, "false", 0],
      violationCount: [null, undefined, NaN, -1, 0.5, Infinity, -Infinity, "0"],
      validationFailureAction: [null, undefined, "Unknown", "enforce", "", 1],
    }
    for (const [field, values] of Object.entries(invalidFields)) {
      for (const value of values) {
        for (const [patch] of precedence) {
          expect(classifyPolicyState(malformedObservation({ ...observation, ...patch, [field]: value }), now, namespace))
            .toBe("unknown")
        }
      }
    }
    for (const value of [null, undefined, false, 42, "policy", {}, []]) {
      expect(classifyPolicyState(malformedObservation(value), now, namespace)).toBe("unknown")
    }
  })

  it("ignores expired and invalid exceptions and preserves the remaining precedence", () => {
    const invalidExceptions = [
      { ...exception, expiresAt: now.toISOString() },
      { ...exception, expiresAt: "invalid" },
      { ...exception, approvedBy: null },
      { ...exception, scope: { namespaces: [] } },
      malformedException({}),
    ]
    for (const invalid of invalidExceptions) {
      for (const [patch, expected] of precedence.filter(([, state]) => state !== "exception")) {
        expect(classifyPolicyState({ ...observation, ...patch, exception: invalid }, now, namespace)).toBe(expected)
      }
    }
  })
})
