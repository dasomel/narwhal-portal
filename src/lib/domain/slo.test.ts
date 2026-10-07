import { describe, expect, it } from "vitest"

import { evaluateSlo, type SloDefinition, type SloObservation } from "./slo"

const now = new Date("2026-10-07T00:00:00Z")
const def: SloDefinition = { objective: 0.5, windowSeconds: 3600, freshnessSeconds: 60, atRiskBudgetRemaining: 0.25 }
const obs: SloObservation = { goodEvents: 100, totalEvents: 100, observedAt: "2026-10-07T00:00:00Z", windowCoveredSeconds: 3600 }

describe("evaluateSlo", () => {
  it.each([
    ["healthy", def, obs],
    ["at-risk", def, { ...obs, goodEvents: 55 }],
    ["breached", def, { ...obs, goodEvents: 49 }],
    ["no-data", def, { ...obs, totalEvents: 0, goodEvents: 0 }],
    ["stale", def, { ...obs, observedAt: "2026-10-06T23:58:59Z" }],
    ["invalid", { ...def, objective: 1 }, obs],
  ])("classifies %s", (state, definition, observation) => {
    expect(evaluateSlo(definition, observation, now).state).toBe(state)
  })

  it("keeps exact objective at zero remaining, without breaching", () => {
    const result = evaluateSlo({ ...def, objective: 0.999 }, { ...obs, goodEvents: 999, totalEvents: 1000 }, now)
    expect(result).toMatchObject({ state: "at-risk", attainment: 0.999, errorBudgetRemaining: 0, burnRate: 1 })
  })

  it("accepts exact at-risk, freshness and future-skew boundaries", () => {
    expect(evaluateSlo({ ...def, atRiskBudgetRemaining: 0.5 }, { ...obs, goodEvents: 75 }, now).state).toBe("healthy")
    expect(evaluateSlo(def, { ...obs, observedAt: "2026-10-06T23:59:00Z" }, now).state).toBe("healthy")
    expect(evaluateSlo(def, { ...obs, observedAt: "2026-10-07T00:01:00Z" }, now).state).toBe("healthy")
    expect(evaluateSlo(def, { ...obs, observedAt: "2026-10-07T00:01:00.001Z" }, now).state).toBe("no-data")
  })

  it.each([100, 55, 49])("caps partial windows with %s good events", (goodEvents) => {
    const result = evaluateSlo(def, { ...obs, goodEvents, windowCoveredSeconds: 3599 }, now)
    expect(result.state).toBe(goodEvents === 100 ? "no-data" : goodEvents === 55 ? "at-risk" : "breached")
    if (goodEvents === 100) expect(result.reasons).toContain("partial-window")
  })

  it("reports stale metrics before zero traffic and budget classification", () => {
    expect(evaluateSlo(def, { ...obs, goodEvents: 49 }, now).state).toBe("breached")
    // Staleness takes precedence over a breached budget, so expired evidence never reports healthy.
    expect(evaluateSlo(def, { ...obs, goodEvents: 49, observedAt: "2026-10-06T23:58:59Z" }, now)).toMatchObject({ state: "stale", attainment: 0.49 })
    expect(evaluateSlo(def, { ...obs, goodEvents: 0, totalEvents: 0, observedAt: "2026-10-06T23:58:59Z" }, now).state).toBe("stale")
  })

  for (const [kind, source] of [["definition", def], ["observation", obs]] as const) {
    for (const field of Object.keys(source)) {
      it.each([undefined, null, NaN, Infinity, -Infinity, "1", -1])(`rejects ${kind}.${field} = %s`, (value) => {
        const input = { ...source, [field]: value }
        const result = evaluateSlo(kind === "definition" ? input : def, kind === "observation" ? input : obs, now)
        expect(result.state).toBe(kind === "definition" ? "invalid" : "no-data")
      })
      it(`contains throwing ${kind}.${field} getters`, () => {
        const input = Object.defineProperty({ ...source }, field, { get() { throw new Error("untrusted") } })
        expect(() => evaluateSlo(kind === "definition" ? input : def, kind === "observation" ? input : obs, now)).not.toThrow()
        expect(evaluateSlo(kind === "definition" ? input : def, kind === "observation" ? input : obs, now).state).toBe(kind === "definition" ? "invalid" : "no-data")
      })
    }
  }

  it.each([null, undefined, 1, "value", true])("rejects non-object input %s", (input) => {
    expect(evaluateSlo(input, obs, now).state).toBe("invalid")
    expect(evaluateSlo(def, input, now).state).toBe("no-data")
  })

  it.each([new Date(NaN), null, undefined, "2026-10-07", {}, new Proxy(now, {})])("rejects invalid clock", (clock) => {
    expect(evaluateSlo(def, obs, clock as Date).state).toBe("invalid")
  })

  it.each(["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-07", "2026-10-07T00:00:00+24:00", "2026-10-07T00:00:00+00:60", "2026-10-07T00:00:00Z\n"])("rejects malformed timestamp %s", (observedAt) => {
    expect(evaluateSlo(def, { ...obs, observedAt }, now).state).toBe("no-data")
  })

  it.each(["2026-10-07T09:00:00+09:00", "2026-10-06T19:00:00-05:00"])("accepts explicit offset %s", (observedAt) => {
    expect(evaluateSlo(def, { ...obs, observedAt }, now).state).toBe("healthy")
  })

  it.each([2 ** 53, 2 ** 60 - 1, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe event counts %s", (count) => {
    for (const patch of [{ goodEvents: count, totalEvents: count }, { goodEvents: count }, { totalEvents: count }]) {
      expect(evaluateSlo(def, { ...obs, ...patch }, now)).toMatchObject({
        state: "no-data", attainment: null, reasons: ["unsafe-event-counts"],
      })
    }
  })

  it("accepts MAX_SAFE_INTEGER event counts", () => {
    expect(evaluateSlo(def, { ...obs, goodEvents: Number.MAX_SAFE_INTEGER, totalEvents: Number.MAX_SAFE_INTEGER }, now))
      .toMatchObject({ state: "healthy", attainment: 1, reasons: [] })
  })

  it.each(["windowSeconds", "freshnessSeconds"])("rejects unsafe definition.%s", (field) => {
    expect(evaluateSlo({ ...def, [field]: Number.MAX_SAFE_INTEGER + 1 }, obs, now).state).toBe("invalid")
  })

  it.each([{ goodEvents: 101 }, { goodEvents: 0.5 }, { totalEvents: 100.5 }])("rejects inconsistent counts %s", (patch) => {
    expect(evaluateSlo(def, { ...obs, ...patch }, now).state).toBe("no-data")
  })

  it.each([{ objective: 0 }, { objective: 1 }, { windowSeconds: 0 }, { windowSeconds: 366 * 86400 + 1 }, { windowSeconds: 1.5 }, { freshnessSeconds: 0 }, { freshnessSeconds: 1.5 }, { atRiskBudgetRemaining: 1.1 }])("rejects invalid definition %s", (patch) => {
    expect(evaluateSlo({ ...def, ...patch }, obs, now).state).toBe("invalid")
  })
})
