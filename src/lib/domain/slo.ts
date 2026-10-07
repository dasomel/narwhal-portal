/** Pure SLO attainment and error budget domain rules. */

export const SLO_STATES = ["healthy", "at-risk", "breached", "no-data", "stale", "invalid"] as const
export type SloState = (typeof SLO_STATES)[number]

export interface SloDefinition {
  objective: number
  windowSeconds: number
  freshnessSeconds: number
  atRiskBudgetRemaining: number
}

export interface SloObservation {
  goodEvents: number
  totalEvents: number
  observedAt: string
  windowCoveredSeconds: number
}

export interface SloResult {
  state: SloState
  attainment: number | null
  errorBudgetRemaining: number | null
  burnRate: number | null
  reasons: string[]
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function snapshot(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {}
  const result: Record<string, unknown> = {}
  for (const field of fields) result[field] = (input as Record<string, unknown>)[field]
  return result
}

function strictTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || match[0] !== value) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthLength = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (day > monthLength) return null
  // D1: Mirror policy's calendar/offset checks without lenient parsing; costs explicit UTC construction. Relax only with a timestamp contract.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  const zone = match[8]
  const offset = zone === "Z" ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === "+" ? 1 : -1)
  return date.getTime() + Number(`0.${match[7] ?? "0"}`) * 1000 - offset * 60000
}

export function evaluateSlo(def: unknown, obs: unknown, now: Date): SloResult {
  const empty = (state: SloState, reason: string): SloResult => ({
    state, attainment: null, errorBudgetRemaining: null, burnRate: null, reasons: [reason],
  })
  let definition: Record<string, unknown>
  let currentTime: number
  // D2: Snapshot getters once and fail closed; costs unavailable evidence. Accept richer inputs only with a revised validation contract.
  try {
    definition = snapshot(def, ["objective", "windowSeconds", "freshnessSeconds", "atRiskBudgetRemaining"])
    currentTime = Date.prototype.getTime.call(now)
  } catch {
    return empty("invalid", "invalid-definition-or-clock")
  }
  const { objective, windowSeconds, freshnessSeconds, atRiskBudgetRemaining } = definition
  if (
    !finite(objective) || !(objective > 0 && objective < 1) ||
    !finite(windowSeconds) || !Number.isSafeInteger(windowSeconds) || !(windowSeconds > 0 && windowSeconds <= 366 * 86400) ||
    !finite(freshnessSeconds) || !Number.isSafeInteger(freshnessSeconds) || !(freshnessSeconds > 0) ||
    !finite(atRiskBudgetRemaining) || !(atRiskBudgetRemaining >= 0 && atRiskBudgetRemaining <= 1) ||
    !finite(currentTime)
  ) return empty("invalid", "invalid-definition-or-clock")
  let observation: Record<string, unknown>
  try {
    observation = snapshot(obs, ["goodEvents", "totalEvents", "observedAt", "windowCoveredSeconds"])
  } catch {
    return empty("no-data", "malformed-observation")
  }
  const { goodEvents, totalEvents, observedAt, windowCoveredSeconds } = observation
  const timestamp = strictTimestamp(observedAt)
  // D4: Reject rounded event counts before ratios; costs unavailable metrics. Use bigint inputs if larger counts are required.
  if ([goodEvents, totalEvents].some((count) => finite(count) && Math.abs(count) > Number.MAX_SAFE_INTEGER)) {
    return empty("no-data", "unsafe-event-counts")
  }
  if (
    !finite(goodEvents) || !Number.isSafeInteger(goodEvents) || !(goodEvents >= 0) ||
    !finite(totalEvents) || !Number.isSafeInteger(totalEvents) || !(totalEvents >= 0) || goodEvents > totalEvents ||
    !finite(windowCoveredSeconds) || !(windowCoveredSeconds >= 0) ||
    timestamp === null || timestamp - currentTime > 60000
  ) return empty("no-data", "malformed-observation")
  const stale = currentTime - timestamp > freshnessSeconds * 1000
  if (totalEvents === 0) return empty(stale ? "stale" : "no-data", stale ? "stale-observation" : "zero-traffic")
  const attainment = goodEvents / totalEvents
  // D3: Exact attainment equality consumes exactly one budget; costs an equality branch. Revise only with numeric boundary semantics.
  const burnRate = attainment === objective ? 1 : (1 - attainment) / (1 - objective)
  const errorBudgetRemaining = 1 - burnRate
  const state = errorBudgetRemaining < 0 ? "breached" : errorBudgetRemaining < atRiskBudgetRemaining ? "at-risk" : "healthy"
  const metrics = { attainment, errorBudgetRemaining, burnRate }
  if (stale) return { ...metrics, state: "stale", reasons: ["stale-observation"] }
  if (windowCoveredSeconds < windowSeconds && state === "healthy") {
    return { ...metrics, state: "no-data", reasons: ["partial-window"] }
  }
  return { ...metrics, state, reasons: [] }
}
