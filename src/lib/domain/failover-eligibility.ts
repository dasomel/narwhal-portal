export const FAILOVER_PRECONDITION_IDS = [
  "active_relation",
  "a1_plan_approved",
  "a2_traffic_change_approved",
  "service_identity_resolved",
  "service_owner_identified",
  "traffic_path_identified",
  "service_scope_authorized",
  "cluster_registered",
  "cluster_probe_healthy",
  "capacity_fresh",
  "service_health_fresh",
  "traffic_path_fresh",
  "adapter_change_preview_exact",
  "withdrawal_confirmed",
  "storage_volumes_identified",
  "source_writer_stopped_or_fenced",
  "destination_data_within_rpo_and_authoritative",
  "single_writer_fencing_verified",
  "service_read_write_validated",
] as const

export type FailoverPreconditionId = (typeof FAILOVER_PRECONDITION_IDS)[number]
export type FailoverEvidenceStatus = "pass" | "fail" | "unknown"
export type FailoverVerdict = "eligible" | "ineligible"

export interface FailoverScope {
  team: string
  tenant: string
  namespace: string
}

export interface FailoverEvidence {
  id: FailoverPreconditionId
  status: FailoverEvidenceStatus
  observedAt: string
  maxAgeMs: number
  source: string
  complete: boolean
}

export interface FailoverClusterEvidence {
  clusterId: string
  team: string
  tenant: string
  namespace: string
  stateful: boolean
  preconditions: readonly FailoverEvidence[]
}

export interface FailoverEligibilityInput {
  scope: FailoverScope
  clusters: readonly FailoverClusterEvidence[]
  now: string
}

export interface FailoverEligibilityResult {
  verdict: FailoverVerdict
  reasons: Array<{ id: FailoverPreconditionId | "evidence_missing" | "evidence_stale" | "evidence_conflict" | "invalid_input"; clusterId?: string }>
  consideredClusterIds: string[]
}

const STATEFUL_PRECONDITIONS: readonly FailoverPreconditionId[] = [
  "storage_volumes_identified",
  "source_writer_stopped_or_fenced",
  "destination_data_within_rpo_and_authoritative",
  "single_writer_fencing_verified",
  "service_read_write_validated",
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

/**
 * Evaluates only in-scope candidates. No evidence or clock is obtained implicitly.
 * §2 of docs/service-failover-safety.md requires missing, stale, conflicting, and unknown evidence to be ineligible.
 */
export function evaluateFailoverEligibility(input: FailoverEligibilityInput): FailoverEligibilityResult {
  const reasons: FailoverEligibilityResult["reasons"] = []
  const consideredClusterIds: string[] = []

  if (!isRecord(input) || !isRecord(input.scope) || !isNonEmptyString(input.scope.team) ||
      !isNonEmptyString(input.scope.tenant) ||
      !isNonEmptyString(input.scope.namespace) || !Array.isArray(input.clusters) ||
      !Number.isFinite(Date.parse(input.now))) {
    return { verdict: "ineligible", reasons: [{ id: "invalid_input" }], consideredClusterIds }
  }

  const now = Date.parse(input.now)
  let hasFailure = false
  for (const cluster of input.clusters) {
    if (!isRecord(cluster) || cluster.team !== input.scope.team || cluster.tenant !== input.scope.tenant ||
        cluster.namespace !== input.scope.namespace) continue
    if (!isNonEmptyString(cluster.clusterId) || !Array.isArray(cluster.preconditions) || typeof cluster.stateful !== "boolean") {
      hasFailure = true
      reasons.push({ id: "invalid_input" })
      continue
    }
    consideredClusterIds.push(cluster.clusterId)
    const required = FAILOVER_PRECONDITION_IDS.filter((id) => cluster.stateful || !STATEFUL_PRECONDITIONS.includes(id))
    for (const id of required) {
      const matches = cluster.preconditions.filter((item) => isRecord(item) && item.id === id)
      if (matches.length === 0) {
        hasFailure = true
        reasons.push({ id: "evidence_missing", clusterId: cluster.clusterId })
        continue
      }
      if (matches.length > 1) {
        hasFailure = true
        reasons.push({ id: "evidence_conflict", clusterId: cluster.clusterId })
        continue
      }
      const evidence = matches[0] as unknown as FailoverEvidence
      const observedAt = Date.parse(evidence.observedAt)
      if (!isNonEmptyString(evidence.source) || typeof evidence.complete !== "boolean" || evidence.complete !== true ||
          !Number.isFinite(evidence.maxAgeMs) || evidence.maxAgeMs < 0 || !Number.isFinite(observedAt) || observedAt > now) {
        hasFailure = true
        reasons.push({ id: "evidence_stale", clusterId: cluster.clusterId })
        continue
      }
      if (now - observedAt > evidence.maxAgeMs) {
        hasFailure = true
        reasons.push({ id: "evidence_stale", clusterId: cluster.clusterId })
      } else if (evidence.status === "fail") {
        hasFailure = true
        reasons.push({ id, clusterId: cluster.clusterId })
      } else if (evidence.status !== "pass") {
        hasFailure = true
        reasons.push({ id: "evidence_missing", clusterId: cluster.clusterId })
      }
    }
  }

  if (consideredClusterIds.length === 0 && reasons.length === 0) {
    return { verdict: "ineligible", reasons: [{ id: "evidence_missing" }], consideredClusterIds }
  }
  return {
    verdict: hasFailure ? "ineligible" : "eligible",
    reasons,
    consideredClusterIds,
  }
}
