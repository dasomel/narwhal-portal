/** Pure restore approval state and preflight domain rules. */

export const RESTORE_STATES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
  "invalidated",
  "executing",
  "reconciling",
  "succeeded",
  "failed",
] as const

export type RestoreState = (typeof RESTORE_STATES)[number]
export type RestoreTerminalState = "denied" | "expired" | "revoked" | "invalidated" | "succeeded" | "failed"
export type RestoreDecisionState = "approved" | "denied" | "expired" | "revoked" | "invalidated" | "executing"

export interface RestoreApprovalState {
  state: RestoreState
  version: number
}

export type RestoreTransitionResult =
  | { applied: true; value: RestoreApprovalState }
  | { applied: false; reason: "decision_conflict" | "invalid_transition" }

const ALLOWED_TRANSITIONS: Readonly<Record<RestoreState, readonly RestoreState[]>> = {
  pending: ["approved", "denied", "expired", "revoked", "invalidated"],
  approved: ["executing", "expired", "revoked", "invalidated"],
  executing: ["reconciling", "succeeded", "failed"],
  reconciling: ["executing", "succeeded", "failed", "reconciling"],
  denied: [],
  expired: [],
  revoked: [],
  invalidated: [],
  succeeded: [],
  failed: [],
}

/** Computes a CAS transition; the caller must persist it with a version predicate atomically. */
export function compareAndSetRestoreState(
  current: RestoreApprovalState,
  expectedVersion: number,
  nextState: RestoreState,
): RestoreTransitionResult {
  if (current.version !== expectedVersion) return { applied: false, reason: "decision_conflict" }
  if (!ALLOWED_TRANSITIONS[current.state].includes(nextState)) {
    return { applied: false, reason: "invalid_transition" }
  }
  return { applied: true, value: { state: nextState, version: current.version + 1 } }
}

/** A worker crash or ambiguous backend response must remain reconcilable. */
export function reconcileExecutingCrash(current: RestoreApprovalState, expectedVersion: number): RestoreTransitionResult {
  return compareAndSetRestoreState(current, expectedVersion, "reconciling")
}

export type RestoreCheckStatus = "pass" | "fail" | "warning" | "unknown"
export type RestorePreflightVerdict = "ready" | "needs-evidence" | "blocked"

export interface RestorePreflightCheck {
  checkId: string
  status: RestoreCheckStatus
}

export function aggregateRestorePreflight(
  requiredCheckIds: readonly string[],
  checks: readonly RestorePreflightCheck[],
): RestorePreflightVerdict {
  if (checks.some((check) => check.status === "fail")) return "blocked"
  const checkIds = new Set(checks.map((check) => check.checkId))
  if (
    requiredCheckIds.length === 0 ||
    checkIds.size !== checks.length ||
    checks.some((check) => !requiredCheckIds.includes(check.checkId)) ||
    requiredCheckIds.some((checkId) => !checkIds.has(checkId))
  ) return "needs-evidence"
  if (checks.some((check) => check.status === "unknown")) return "needs-evidence"
  return "ready"
}

export interface RestoreTenantScope {
  namespace: string
  ownerTeam: string
}

/** Caller-supplied scope is deliberately not an input: only the server resolution is returned. */
export function resolveRestoreTenantScope(serverScope: RestoreTenantScope | null): RestoreTenantScope | null {
  if (!serverScope?.namespace.trim() || !serverScope.ownerTeam.trim()) return null
  return { namespace: serverScope.namespace, ownerTeam: serverScope.ownerTeam }
}
