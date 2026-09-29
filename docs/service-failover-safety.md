# Multi-Cluster Service Failover / Evacuation Safety Contract

- **Status**: Proposed operational contract (Portal workflow is not implemented)
- **Scope**: Failover safety preconditions, operator approval points, and evidence required for service traffic failover or cluster evacuation.
- **Related**: Narwhal #132; Portal #11, #21, #22, #29, #30, #36

## 1. Current repo boundary

This document defines a proposed safety contract; it does not describe an existing Portal workflow. `docs/domain-api-cluster-fleet.md` explicitly limits the implemented domain model to a read-only `Cluster`/`Fleet` pilot. `ClusterDomainObject` in `src/lib/domain/cluster.ts` contains cluster identity, health, capability states, resource reference, and freshness, but has no service topology, traffic lifecycle, or mutation fields. The health vocabulary in `src/types/cluster.ts` is `unknown | healthy | degraded | offline`; the issue's `active | draining | standby | failed | quarantined` are not current cluster states.

The repo does not implement traffic steering via Gateway, DNS, MCS, or east-west networking, cluster drain/evacuation mutations, storage ownership/fencing checks, service-target authorization, or failover replay. `src/app/api/domain/clusters/route.ts` is a read path; `src/lib/hero.ts` also records cordon/drain as omitted pending routes. Treat every workflow rule and service evidence field below as **PROPOSED** until the owning cluster-side contract and Portal implementation exist. Do not infer traffic eligibility from cluster health alone.

## 2. Proposed state and eligibility rules

The following is a service-to-cluster relation, not a replacement for `ClusterHealthStatus`.

| Relation state | Traffic target eligible? | Required interpretation |
|---|---:|---|
| `active` | Only if all gates below pass | Serving or approved to serve this service. |
| `standby` | No, until an approved activation | Candidate capacity; no traffic before activation. |
| `draining` | No | Traffic withdrawal is underway or verified; never count as healthy destination. |
| `failed` | No | Failure is observed or declared; health/endpoint evidence may be stale. |
| `quarantined` | No | Explicit operator/policy hold, regardless of apparent health. |

**PROPOSED eligibility predicate:** a target is eligible only when relation state is `active`, the selected service is authorized in the requested team/tenant scope, the cluster is registered and its current probe is `healthy`, required service and traffic-path checks are fresh, and (for stateful services) storage ownership/fencing prerequisites are affirmatively verified. Missing, stale, conflicting, or unknown input evaluates to **ineligible**, not healthy. Cluster capability `storage: supported` is only the registry declaration after basic liveness/authentication (`src/lib/domain/cluster.ts`); it is not proof of volume replication, ownership, or fencing.

**PROPOSED freshness rule:** every health, endpoint, and steering observation must carry `observedAt`, source, and a policy-defined maximum age. The workflow must expose age and source. If the maximum age is absent, exceeded, or source reports truncation/incompleteness, block promotion and retain the last known state as stale. `DomainFreshness` (`asOf`, `source`, `cacheAgeSeconds`) and governance event freshness (`src/lib/governance-operational-events.ts`) are existing patterns, not a defined failover TTL.

## 3. Proposed safety sequence and operator gates

| Phase | Preconditions / evidence to check | Operator approval point | Block or stop when |
|---|---|---|---|
| **Plan** | Service identity and owner; source and destination cluster IDs; team/tenant authorization; traffic entry path and mechanism (`Gateway`, `DNS`, `MCS`, `east-west`, or `unknown`); current and target relation state; freshness timestamps. | **A1 — approve plan**: operator confirms service, scope, source, destination, reason, and planned/unplanned path. | Service mapping, owner, authorization, or traffic path is unknown. Unknown path cannot be treated as withdrawn. |
| **Preflight** | Destination passes eligibility predicate; capacity and service health evidence are fresh; traffic control adapter reports the exact intended change; stateful checklist completed where applicable. | **A2 — approve traffic change**: operator confirms the concrete route/weight/endpoint action and rollback target. | Health is stale/unknown; destination is draining/failed/quarantined; stateful ownership/fencing is unverified; preview differs from approved plan. |
| **Withdraw source** | Source relation transitions to `draining`; withdrawal command and target are recorded. | Approval follows the configured policy. **PROPOSED policy:** explicit approval required for manual traffic changes; automated policy must be separately defined. | Withdrawal is not acknowledged by the steering system, or observed traffic/endpoint state remains contradictory. Do not start destructive evacuation. |
| **Evacuate workload/storage** | Traffic withdrawal is verified; workload relocation and storage safety evidence are available. | **A3 — approve destructive evacuation/maintenance**: separate confirmation after withdrawal evidence, naming the exact cluster and affected workloads/storage. | Stateful ownership is ambiguous, fencing is absent, split-brain risk is unresolved, or traffic is still observed. |
| **Maintenance / recovery** | Maintenance result and post-recovery cluster probe recorded. | **A4 — approve re-entry** after health validation; **A5 — approve failback** separately if returning traffic to the recovered cluster. | Any health or service check is failing, stale, or unknown. Recovery alone does not authorize traffic re-entry. |

The planned order is **traffic withdrawal → workload/storage evacuation → cluster maintenance**. For an unplanned failure, source withdrawal can proceed only under an explicitly defined emergency policy; an unreachable source does not prove endpoints or traffic control have converged. Record the emergency decision and its approver. Failback repeats destination preflight and approval; it is not an automatic reversal of failover.

## 4. Stateful-service hard gate

**PROPOSED required checks**, recorded individually as `pass | fail | unknown` with evidence reference and observation time:

1. Identify the service's persistent volumes and authoritative storage/replication system.
2. Confirm the source writer is stopped or fenced before enabling a destination writer.
3. Confirm destination data is within the service's approved recovery point and ownership/replication state is authoritative.
4. Confirm no second writer can accept writes; document the fencing mechanism and its observed result.
5. Record service-level read/write validation after activation.

Any `fail` or `unknown` blocks stateful activation, evacuation that could destroy the only valid copy, and failback. Portal #30 is related, but no storage safety API or evidence shape is present in the inspected Portal contract; these checks require an authoritative storage/cluster-side producer. A cluster capability flag is insufficient.

## 5. Required operation and evidence record

Each planned or emergency traffic/evacuation action **PROPOSED** must create one operation context and append an immutable event/evidence record for each decision and observed transition. Use the existing Portal #11 vocabulary where it applies: `operation_id`, `correlation_id`, `causation_id`, `request_id`, `actor`, `resource`, and lifecycle `operation.started | operation.completed | operation.failed` (`src/lib/operation-context.ts`, `src/types/event-envelope.ts`). `resource.cluster` is an `EventResource` field; current `beginOperation()` defaults it to `DEFAULT_CLUSTER_ID` (`src/types/cluster.ts`) unless the caller supplies a resolved cluster. Therefore a future multi-cluster workflow must explicitly supply the relevant cluster per action and must not rely on that default.

**PROPOSED record fields** (required unless marked nullable):

| Field | Meaning / validation |
|---|---|
| `operation_id`, `correlation_id`, `actor.id`, `actor.type` | Existing operation/envelope identifiers and actor; correlate all phases of one workflow. |
| `cluster_id`, `service_id`, `team_or_tenant`, `phase`, `decision` | Explicit scope and transition; `cluster_id` must identify the source or destination for this action. |
| `source_cluster_id`, `destination_cluster_id`, `from_state`, `to_state` | Both clusters and relation transition; states use §2 vocabulary. |
| `traffic_entry_path`, `steering_mechanism`, `change_reference` | Exact path/control plane and external change/ack identifier; mechanism may be `unknown`, which blocks claiming verified withdrawal. |
| `preconditions[]` | Each check has `name`, `result: pass|fail|unknown`, `observed_at`, `source`, `evidence_ref`; no missing check may default to pass. |
| `approval[]` | `approval_id`, approving actor, timestamp, gate (`A1`–`A5`), approved plan/change digest; emergency rationale when applicable. |
| `evidence_refs[]`, `evidence_digest` | Stable references plus digest for retained evidence; never put credentials or secret values in evidence. |
| `started_at`, `completed_at`, `outcome`, `error_code`, `error_summary` | Lifecycle timing and terminal result; failed/partial operations remain visible and are not reported as successful. |
| `snapshot_version`, `captured_at` | Offline replay metadata; snapshot includes inputs and policy version needed to reproduce the decision. |

This is a proposed extension, not the current `EventEnvelope` schema: current `EventResource` supports `cluster`, `namespace`, `kind`, `name`, and `workload`, but not `service_id`; the envelope has nullable `evidence_id`, while this repo does not define a failover evidence store. Kubernetes operational events are explicitly operational signals, not authoritative audit evidence (`docs/governance-events-api.md`); they cannot alone satisfy approval or change evidence.

## 6. Error outcomes and replay

**PROPOSED terminal outcomes:**

- `blocked_precondition`: a required gate is false, missing, stale, or unknown; no traffic/evacuation mutation is authorized.
- `blocked_approval`: the required gate lacks a valid approval or approved plan digest does not match the action.
- `withdrawal_unverified`: steering system did not acknowledge or observed traffic contradicts withdrawal; destructive phase remains prohibited.
- `storage_safety_unverified`: ownership/fencing/split-brain evidence is missing or contradictory; no stateful activation/destructive action.
- `partial`: an action began but convergence or post-check failed; preserve evidence and require operator resolution.
- `failed`: action failed; record the observed error and leave eligibility false until a fresh check establishes otherwise.
- `completed`: all required transitions and post-checks passed with fresh evidence; this outcome alone permits the next approved phase.

An offline snapshot/replay **PROPOSED** must preserve the ordered input observations, their timestamps and source/freshness, service-to-cluster mapping, authorization decision, policy version, approvals, requested steering action, adapter acknowledgement, operation/correlation IDs, and resulting evidence references/digests. Replay must execute the same eligibility and transition decision as the original snapshot without making live mutations. If any decision input is absent or altered, replay reports `incomplete` or `mismatch`, never a reproduced success. Existing `src/lib/domain/cluster.fixtures.ts` demonstrates fixture-based cluster projection only; it does not replay service failover.

## 7. Acceptance checks for a future implementation

1. A selected service lists each cluster relation, state, eligibility result, blocking reasons, traffic path/mechanism, and observation freshness.
2. `draining`, `failed`, and `quarantined` never appear as eligible targets; stale or unknown inputs never render as verified healthy.
3. Planned evacuation cannot cross into destructive workload/storage/maintenance steps until withdrawal is acknowledged and observed, with policy-required approval attached.
4. Stateful activation is blocked unless ownership, fencing, replication/RPO, and single-writer checks all pass with current evidence.
5. Re-entry and failback require fresh health/service checks and distinct approval records.
6. Every action has explicit source/destination `cluster_id`, `service_id`, `operation_id`, `correlation_id`, actor, approval, and evidence references, and offline replay yields the same decision from the captured inputs.

These are document-level criteria for implementation planning; this file does not claim they currently pass.
