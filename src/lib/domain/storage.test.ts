import { describe, expect, it } from "vitest"
import { evaluatePvcExpansion, parseStorageQuantity, type PvcExpansionRequest } from "./storage"

describe("storage quantity parser", () => {
  it.each([
    ["0", BigInt("0")], ["1", BigInt("1")], ["1Ki", BigInt("1024")], ["1Mi", BigInt("1024") ** BigInt("2")],
    ["1Gi", BigInt("1024") ** BigInt("3")], ["1Ti", BigInt("1024") ** BigInt("4")], ["1Pi", BigInt("1024") ** BigInt("5")], ["1Ei", BigInt("1024") ** BigInt("6")],
    ["1k", BigInt("1000")], ["1M", BigInt("1000") ** BigInt("2")], ["1G", BigInt("1000") ** BigInt("3")],
    ["1T", BigInt("1000") ** BigInt("4")], ["1P", BigInt("1000") ** BigInt("5")], ["1E", BigInt("1000") ** BigInt("6")],
    ["1.5Gi", BigInt("1610612736")], ["0.125Ki", BigInt("128")], ["0.001k", BigInt("1")],
    ["1.000", BigInt("1")], ["0.0", BigInt("0")], ["9223372036854775807", BigInt("9223372036854775807")],
    ["9007199254740993", BigInt("9007199254740993")],
  ] as const)("parses %s exactly", (input, bytes) => {
    expect(parseStorageQuantity(input)).toBe(bytes)
  })

  it.each([
    "__proto__", "constructor", "", " ", " 1", "1 ", "1\n", "01", "00", "00.5Gi", "+1", "-1", "1e3", "1E3",
    "1m", "1gi", "1KI", "1K", ".5Gi", "1.", "NaN", "Infinity", "0.1", "0.1Ki",
    "9223372036854775808", "8Ei", "99999999999999999999999999999999999999999",
    null, undefined, 1, BigInt("1"), NaN, true, {}, [], new String("1"),
  ])("rejects %s without throwing", (input) => {
    expect(parseStorageQuantity(input)).toBeNull()
  })
  it("rejects oversized input before BigInt work", () => {
    const start = performance.now()
    expect(parseStorageQuantity("9".repeat(10_000))).toBeNull()
    expect(performance.now() - start).toBeLessThan(100)
  })
})

const complete: PvcExpansionRequest = {
  currentBytes: "1Gi",
  requestedBytes: "2Gi",
  storageClass: { name: "expandable", allowVolumeExpansion: true, provisioner: null },
  quotaHeadroomBytes: "1Gi",
  boundPhase: "Bound",
  resizeInProgress: false,
}

describe("PVC expansion", () => {
  it.each([undefined, null, "true", "false", 0, 1, {}])("requires boolean resize evidence: %j", (resizeInProgress) => {
    expect(evaluatePvcExpansion({ ...complete, resizeInProgress })).toEqual({
      verdict: "needs-evidence", reasons: ["resize-state-unknown"],
    })
  })

  it.each([undefined, null, "false", "true", 0, 1])("requires boolean class evidence: %j", (allowVolumeExpansion) => {
    expect(evaluatePvcExpansion({ ...complete, storageClass: { allowVolumeExpansion } })).toEqual({
      verdict: "needs-evidence", reasons: ["class-unknown"],
    })
  })

  it.each([undefined, null, "expandable", false, 1, {}])("requires object class evidence: %j", (storageClass) => {
    expect(evaluatePvcExpansion({ ...complete, storageClass })).toEqual({
      verdict: "needs-evidence", reasons: ["class-unknown"],
    })
  })

  it.each([undefined, null, false, 0, {}])("requires string phase evidence: %j", (boundPhase) => {
    expect(evaluatePvcExpansion({ ...complete, boundPhase })).toEqual({
      verdict: "needs-evidence", reasons: ["phase-unknown"],
    })
  })

  it.each(["resizeInProgress", "storageClass", "boundPhase"])("rejects missing field %s", (field) => {
    const request: Record<string, unknown> = { ...complete }
    delete request[field]
    expect(evaluatePvcExpansion(request).verdict).toBe("needs-evidence")
  })

  it.each([null, undefined, false, 0, "request", {}])("never throws on invalid request %j", (request) => {
    expect(evaluatePvcExpansion(request)).toEqual({ verdict: "blocked", reasons: [
      "requested-unparseable", "current-unknown", "class-unknown", "quota-evidence-missing", "phase-unknown", "resize-state-unknown",
    ] })
  })

  it("contains throwing property access", () => {
    expect(evaluatePvcExpansion({ get requestedBytes() { throw new Error("bad access") } }).verdict).toBe("blocked")
  })

  it("allows complete evidence at the exact quota boundary", () => {
    expect(evaluatePvcExpansion(complete)).toEqual({ verdict: "allowed", reasons: [] })
  })

  it("blocks one byte beyond headroom using exact BigInt delta", () => {
    expect(evaluatePvcExpansion({ ...complete, requestedBytes: "2147483649" })).toEqual({
      verdict: "blocked", reasons: ["exceeds-quota-headroom"],
    })
    expect(evaluatePvcExpansion({
      ...complete, currentBytes: "9007199254740993", requestedBytes: "9007199254740995", quotaHeadroomBytes: "1",
    })).toEqual({ verdict: "blocked", reasons: ["exceeds-quota-headroom"] })
  })

  it.each(["1Gi", "0"])("blocks equal or shrinking capacity %s", (requestedBytes) => {
    expect(evaluatePvcExpansion({ ...complete, requestedBytes })).toEqual({
      verdict: "blocked", reasons: ["requested-not-larger"],
    })
  })

  it.each(["", "-1", "NaN", "0.1"])("blocks unparseable request %s", (requestedBytes) => {
    expect(evaluatePvcExpansion({ ...complete, requestedBytes })).toEqual({
      verdict: "blocked", reasons: ["requested-unparseable"],
    })
  })

  it.each([
    [{ storageClass: { ...complete.storageClass!, allowVolumeExpansion: false } }, "class-expansion-unsupported"],
    [{ resizeInProgress: true }, "resize-in-progress"],
    [{ boundPhase: "Pending" }, "not-bound"],
    [{ boundPhase: "" }, "not-bound"],
  ] as const)("blocks known adverse evidence %j", (fields, reason) => {
    expect(evaluatePvcExpansion({ ...complete, ...fields })).toEqual({ verdict: "blocked", reasons: [reason] })
  })

  it.each([
    [{ currentBytes: null }, "current-unknown"],
    [{ currentBytes: "NaN" }, "current-unknown"],
    [{ storageClass: null }, "class-unknown"],
    [{ storageClass: { ...complete.storageClass!, allowVolumeExpansion: null } }, "class-unknown"],
    [{ quotaHeadroomBytes: null }, "quota-evidence-missing"],
    [{ quotaHeadroomBytes: "-1" }, "quota-evidence-missing"],
    [{ boundPhase: null }, "phase-unknown"],
    [{ resizeInProgress: null }, "resize-state-unknown"],
  ] as const)("never allows missing evidence %j", (fields, reason) => {
    expect(evaluatePvcExpansion({ ...complete, ...fields })).toEqual({ verdict: "needs-evidence", reasons: [reason] })
  })

  it("retains every missing reason and blocks a blank request", () => {
    const unknown = { currentBytes: null, storageClass: null, quotaHeadroomBytes: null, boundPhase: null, resizeInProgress: null }
    const missing = ["current-unknown", "class-unknown", "quota-evidence-missing", "phase-unknown", "resize-state-unknown"]
    expect(evaluatePvcExpansion({ ...unknown, requestedBytes: "2Gi" })).toEqual({ verdict: "needs-evidence", reasons: missing })
    expect(evaluatePvcExpansion({ ...unknown, requestedBytes: "" })).toEqual({
      verdict: "blocked", reasons: ["requested-unparseable", ...missing],
    })
  })

  it("collects simultaneous blockers before missing evidence deterministically", () => {
    const request = {
      ...complete, requestedBytes: "3Gi", storageClass: { ...complete.storageClass!, allowVolumeExpansion: false },
      resizeInProgress: true, boundPhase: "Pending",
    }
    expect(evaluatePvcExpansion(request)).toEqual({ verdict: "blocked", reasons: [
      "class-expansion-unsupported", "exceeds-quota-headroom", "resize-in-progress", "not-bound",
    ] })
    expect(evaluatePvcExpansion({ ...request, currentBytes: null })).toEqual({ verdict: "blocked", reasons: [
      "class-expansion-unsupported", "resize-in-progress", "not-bound", "current-unknown",
    ] })
  })
})
