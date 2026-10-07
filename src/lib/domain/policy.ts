/** Pure policy observation and exception domain rules. */

export const POLICY_STATES = [
  "enforced",
  "audit",
  "not-ready",
  "violating",
  "exception",
  "drifted",
  "unknown",
] as const

export type PolicyState = (typeof POLICY_STATES)[number]

export interface PolicyObservation {
  ready: boolean | null
  validationFailureAction: "Enforce" | "Audit" | string | null
  violationCount: number | null
  driftedFromGit: boolean | null
  exception: PolicyException | null
}

export interface PolicyException {
  owner: string
  reason: string
  expiresAt: string | null
  approvedBy: string | null
  scope: { namespaces: readonly string[] }
}

export type PolicyExceptionResult = {
  active: boolean
  reason: "ok" | "missing-owner" | "missing-reason" | "missing-expiry" | "expired" | "unapproved" | "out-of-scope" | "invalid-expiry" | "invalid-clock"
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

// Rejection order: owner, reason, expiry-missing, invalid-expiry, invalid-clock, expired, approver, scope.
export function evaluatePolicyException(
  exception: PolicyException | null,
  now: Date,
  targetNamespace: string,
): PolicyExceptionResult {
  if (!nonblank(exception?.owner)) return { active: false, reason: "missing-owner" }
  if (!nonblank(exception?.reason)) return { active: false, reason: "missing-reason" }
  if (exception?.expiresAt == null || exception.expiresAt === "") return { active: false, reason: "missing-expiry" }
  const expiryFormat = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
  const match = typeof exception.expiresAt === "string" ? expiryFormat.exec(exception.expiresAt) : null
  if (!match) return { active: false, reason: "invalid-expiry" }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  // D4: Reject calendar rollover to avoid extending exceptions; costs a calendar check. Relax only with a revised expiry contract.
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthLength = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (day > monthLength || hour > 23 || minute > 59 || second > 59) return { active: false, reason: "invalid-expiry" }
  const expiresAt = Date.parse(exception.expiresAt)
  if (!Number.isFinite(expiresAt)) return { active: false, reason: "invalid-expiry" }
  const currentTime = now instanceof Date ? now.getTime() : NaN
  if (!Number.isFinite(currentTime)) return { active: false, reason: "invalid-clock" }
  // D3: Deny at equality; strict expiry costs renewal lead time. Change only with the expiry contract.
  if (expiresAt <= currentTime) return { active: false, reason: "expired" }
  if (!nonblank(exception.approvedBy)) return { active: false, reason: "unapproved" }
  const namespaces = exception.scope?.namespaces
  if (!Array.isArray(namespaces) || !nonblank(targetNamespace) || targetNamespace === "*" || !namespaces.includes(targetNamespace)) {
    return { active: false, reason: "out-of-scope" }
  }
  return { active: true, reason: "ok" }
}

export function classifyPolicyState(
  obs: PolicyObservation,
  now: Date,
  targetNamespace: string,
): PolicyState {
  // D1: Unknown outranks not-ready for an unrecognised action because the enforcement mode cannot be trusted; revise the mode contract to relax this.
  // D2: Validate before precedence; incomplete evidence costs availability. Relax only with a revised observation contract.
  if (
    !obs ||
    typeof obs.ready !== "boolean" ||
    typeof obs.driftedFromGit !== "boolean" ||
    typeof obs.violationCount !== "number" ||
    !Number.isInteger(obs.violationCount) ||
    obs.violationCount < 0 ||
    (obs.validationFailureAction !== "Enforce" && obs.validationFailureAction !== "Audit")
  ) return "unknown"
  if (!obs.ready) return "not-ready"
  if (obs.exception && evaluatePolicyException(obs.exception, now, targetNamespace).active) return "exception"
  if (obs.driftedFromGit) return "drifted"
  if (obs.violationCount > 0) return "violating"
  if (obs.validationFailureAction === "Enforce") return "enforced"
  return "audit"
}
