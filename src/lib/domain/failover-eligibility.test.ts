import { describe, expect, it } from "vitest"
import { evaluateFailoverEligibility, FAILOVER_PRECONDITION_IDS, type FailoverClusterEvidence } from "./failover-eligibility"

const now = "2026-09-30T00:00:00.000Z"
// Independent copy of the checks required by docs/service-failover-safety.md §§2–4.
const DOCUMENTED_PRECONDITION_IDS = [
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

const passing = (): FailoverClusterEvidence => ({
  clusterId: "cluster-a",
  team: "payments",
  tenant: "tenant-a",
  namespace: "payments-prod",
  stateful: true,
  preconditions: FAILOVER_PRECONDITION_IDS.map((id) => ({
    id, status: "pass" as const, observedAt: now, maxAgeMs: 60_000, source: "probe", complete: true,
  })),
})
const input = (clusters: readonly FailoverClusterEvidence[]) => ({
  scope: { team: "payments", tenant: "tenant-a", namespace: "payments-prod" }, clusters, now,
})

describe("evaluateFailoverEligibility", () => {
  it("keeps the exported checks equal to the independent documented list", () => {
    expect([...FAILOVER_PRECONDITION_IDS].sort()).toEqual([...DOCUMENTED_PRECONDITION_IDS].sort())
  })

  it("is eligible only with complete fresh passing evidence for every precondition", () => {
    expect(evaluateFailoverEligibility(input([passing()]))).toEqual({
      verdict: "eligible", reasons: [], consideredClusterIds: ["cluster-a"],
    })
  })

  it.each(DOCUMENTED_PRECONDITION_IDS)("blocks when %s fails", (id) => {
    const candidate = passing()
    candidate.preconditions = candidate.preconditions.map((evidence) => evidence.id === id
      ? { ...evidence, status: "fail" as const }
      : evidence)
    const result = evaluateFailoverEligibility(input([candidate]))
    expect(result.verdict, id).toBe("ineligible")
    expect(result.reasons).toContainEqual({ id, clusterId: "cluster-a" })
  })

  it("accepts evidence exactly at its freshness limit and marks evidence just over it stale", () => {
    const candidate = passing()
    candidate.preconditions = candidate.preconditions.map((evidence) => ({
      ...evidence, observedAt: "2026-09-29T23:59:00.000Z", maxAgeMs: 60_000,
    }))
    expect(evaluateFailoverEligibility(input([candidate])).verdict).toBe("eligible")
    candidate.preconditions = candidate.preconditions.map((evidence) => ({ ...evidence, maxAgeMs: 59_999 }))
    const result = evaluateFailoverEligibility(input([candidate]))
    expect(result.verdict).toBe("ineligible")
    expect(result.reasons).toContainEqual({ id: "evidence_stale", clusterId: "cluster-a" })
  })

  it("never includes evidence from another team, tenant, or namespace", () => {
    const outside = { ...passing(), clusterId: "secret-cluster", team: "other", preconditions: [] }
    const result = evaluateFailoverEligibility(input([outside]))
    expect(result.consideredClusterIds).toEqual([])
    expect(result.verdict).toBe("ineligible")
    const otherTenant = { ...passing(), clusterId: "other-tenant", tenant: "tenant-b", preconditions: [] }
    expect(evaluateFailoverEligibility(input([otherTenant])).consideredClusterIds).toEqual([])
    const otherNamespace = { ...passing(), clusterId: "other-namespace", namespace: "other", preconditions: [] }
    expect(evaluateFailoverEligibility(input([otherNamespace])).consideredClusterIds).toEqual([])
  })

  it("requires evidence and detects duplicate conflicting observations", () => {
    expect(evaluateFailoverEligibility(input([])).verdict).toBe("ineligible")
    const candidate = passing()
    candidate.preconditions = candidate.preconditions.filter(({ id }) => id !== "active_relation")
    expect(evaluateFailoverEligibility(input([candidate])).verdict).toBe("ineligible")
    const active = passing().preconditions.find(({ id }) => id === "active_relation")!
    candidate.preconditions = [...candidate.preconditions, active, active]
    expect(evaluateFailoverEligibility(input([candidate])).verdict).toBe("ineligible")
    candidate.preconditions = candidate.preconditions.slice(0, -1)
    candidate.preconditions = [...candidate.preconditions, {
      id: "active_relation", status: "fail", observedAt: now, maxAgeMs: 60_000, source: "probe", complete: true,
    }, {
      id: "active_relation", status: "pass", observedAt: now, maxAgeMs: 60_000, source: "probe", complete: true,
    }]
    const result = evaluateFailoverEligibility(input([candidate]))
    expect(result.verdict).toBe("ineligible")
    expect(result.reasons).toContainEqual({ id: "evidence_conflict", clusterId: "cluster-a" })
  })

  it("marks unknown evidence ineligible", () => {
    const candidate = passing()
    candidate.preconditions = candidate.preconditions.map((evidence) => evidence.id === "active_relation"
      ? { ...evidence, status: "unknown" as const }
      : evidence)
    expect(evaluateFailoverEligibility(input([candidate])).verdict).toBe("ineligible")
  })

  it("fails closed on hostile or malformed input", () => {
    expect(evaluateFailoverEligibility(null as never).verdict).toBe("ineligible")
    expect(evaluateFailoverEligibility({ ...input([passing()]), now: "not-a-date" }).verdict).toBe("ineligible")
    const candidate = passing()
    candidate.preconditions = candidate.preconditions.map((evidence, index) => index === 0
      ? { ...evidence, maxAgeMs: Number.POSITIVE_INFINITY }
      : evidence)
    expect(evaluateFailoverEligibility(input([candidate])).verdict).toBe("ineligible")
  })
})
