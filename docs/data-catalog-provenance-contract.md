# Data Catalog Entity and Provenance Contract

- **Status**: Proposal (documentation only; no data-catalog provider contract is implemented)
- **Scope**: Minimal read-side projection for Portal; source systems remain authoritative.
- **Related**: portal#31 (Service Catalog Scope), portal#36 (Narwhal → Portal Capability Parity), narwhal#127/#129/#131/#134/#154

## 1. Repository baseline

The existing `/catalog` is an Argo CD **application** catalog. `CatalogService` in
[`src/lib/argocd.ts`](../src/lib/argocd.ts) contains application name, project, destination
namespace, repository/revision, sync and health status, deployment time, resource count, and
optional owner/runbook. `/api/catalog` scopes those applications with `appVisible` and
`getEffectiveScope` ([`src/app/api/catalog/route.ts`](../src/app/api/catalog/route.ts),
[`src/lib/scope.ts`](../src/lib/scope.ts)). This does not establish that an application is a
dataset or data product.

The repository has no implemented Iceberg, Trino, Ranger, OpenLineage, vector-store, embedding,
or model-registry client or data-catalog domain type (repository search across `src/`, `docs/`,
and `protos/`). The companion GitOps overview documents SeaweedFS as object storage for Loki,
Tempo, Velero, and CNPG, but that infrastructure storage inventory does not expose dataset
catalog or lineage records to Portal ([`../narwhal/gitops/README.md`](../../narwhal/gitops/README.md),
Storage & Backup). Existing adjacent Portal evidence is narrower:

| Existing Portal source | What can be projected today | What it does not prove |
|---|---|---|
| Argo CD via `getArgoApps` / `appToCatalogService` | Application identity, project/namespace, repository revision, sync/health, last deployment, owner annotation | Dataset identity, dataset owner, data classification, lineage, data quality, retention, or model promotion |
| Kubernetes via `getNamespaces` and K8s clients | Namespace and Kubernetes resource observations, subject to caller scope | Data contents, table/schema identity, policy decision, or legal hold |
| Scorecard via `evaluateAll` (`src/app/api/scorecards/route.ts`) | Rule results with `failedRuleIds`, `unavailableRuleIds`, and `evaluationComplete` for service checks | Data contract/schema-quality status; service score is not data compliance |
| Cost via `getCost` (`src/app/api/cost/route.ts`) | Cost items plus telemetry and freshness/exclusion metadata | Dataset usage provenance or lifecycle evidence |
| Governance scorecard (`src/app/api/governance/scorecard/route.ts`) | Argo CD sync/health, Alertmanager, and resource-derived service summary | Data access policy or data quality |
| Event envelope (`src/types/event-envelope.ts`) and operation context (`src/lib/operation-context.ts`) | Correlation/causation/operation IDs and optional `evidence_id`, actor, source, and cluster/namespace resource context for Portal events | A retrievable, immutable evidence artifact or source-provider lineage record. Kubernetes operational Events are explicitly not authoritative audit evidence (`docs/governance-events-api.md`). |

## 2. Minimal entity model — PROPOSED

This is a normalized projection vocabulary, not a claim that each entity type already exists in a
provider or Portal API. Each entity has the common fields below; type-specific fields follow.

### 2.1 Common entity fields

| Field | Required | Meaning / constraint |
|---|---:|---|
| `id` | yes | Stable, opaque, globally unique identifier. **PROPOSED** form: `<kind>:<provider>:<provider-native-id>`; never derive it from a display label. |
| `kind` | yes | One of `source`, `dataset`, `data_product`, `pipeline`, `query`, `model`, `embedding`, `vector_index`, `endpoint`. |
| `name` | yes | Human-readable source label; not an authorization key. |
| `provider` | yes | Owning system identifier; e.g. `argocd` only for data actually sourced from Argo CD. |
| `nativeId` | yes | Exact provider-native identifier and its `provider`; preserve case and punctuation. |
| `scope` | yes | `{ clusterId, namespace, teamId, tenantId }`; values may be `null` only when the source is cluster/global scoped and says so. A null value is not a wildcard grant. |
| `observedAt` | yes | ISO-8601 UTC time the provider observation was made. |
| `sourceVersion` | no | Provider revision/version, if returned (for example Argo CD revision). |
| `ownerRef` | no | Stable identity reference of an owner from an authoritative source. Argo CD `narwhal.io/owner` is only an annotation value; it is not verified identity by itself. |
| `classification` | yes | `{ value, source, observedAt, version }`; value is one of `public`, `internal`, `confidential`, `restricted`, `unknown`. `unknown` is explicit and never upgraded based on absence of a finding. |
| `evidenceRefs` | yes | Array, possibly empty, of evidence references described in §3. Empty means no linked evidence is available, not that the entity passed a check. |
| `freshness` | yes | `{ state, observedAt, staleAfterSeconds }`; state is `fresh`, `stale`, `unknown`, or `unavailable`. Threshold is source-specific and must be declared by that source adapter. |

### 2.2 Entity-specific fields and relationships

| Kind | Additional fields | Outgoing edge types |
|---|---|---|
| `source` | `sourceType`, optional `locationRef` (redacted/non-secret provider locator) | `produces` → dataset or source document |
| `dataset` | `format`, `schemaRef`, optional `contractRef` | `derived_from` → source/dataset; `read_by` or `written_by` → pipeline/query |
| `data_product` | `description`, `domain`, `ownerRef` | `contains` → dataset; `served_by` → endpoint |
| `pipeline` | `runId`, `runState`, `startedAt`, `finishedAt` | `reads` / `writes` → dataset; `produces` → model/embedding |
| `query` | `queryId`, `queryHash`, `executedAt`; do not store raw query text by default | `reads` / `writes` → dataset |
| `model` | `modelVersion`, `registryRef`, optional evaluation state | `trained_from` → dataset; `promoted_as` → endpoint |
| `embedding` | `modelRef`, `modelVersion`, `dimensions`, `runId` | `computed_from` → source document/chunk; `indexed_in` → vector index |
| `vector_index` | `indexVersion`, `tenantBoundary`, `accessPolicyRef` | `contains` → embedding/chunk; `serves` → endpoint |
| `endpoint` | `endpointRef`, `deploymentRef` | `serves` → model/vector index/data product |

An edge is `{ id, fromId, relation, toId, observedAt, provider, evidenceRefs, freshness }`.
Edges require source-backed identifiers at both ends. A shared namespace, matching names, or UI
label is not lineage evidence. Unknown relationships are omitted; they are not synthesized.

## 3. Provenance and evidence linkage — PROPOSED projection contract

Every observation or relationship carries provenance sufficient to reproduce its origin:

```text
Provenance = {
  provider: string,
  providerRecordId: string,
  observedAt: ISO-8601 UTC timestamp,
  providerVersion: string | null,
  correlationId: string | null,
  requestId: string | null,
  evidenceRefs: EvidenceRef[]
}

EvidenceRef = {
  id: string,
  kind: "provider-record" | "event" | "report" | "artifact",
  provider: string,
  locator: string,
  digest: string | null,
  observedAt: ISO-8601 UTC timestamp,
  scope: { clusterId: string | null, namespace: string | null, teamId: string | null, tenantId: string | null }
}
```

`locator` must identify a provider record or retained artifact without embedding credentials or
secret material. `digest` is a content digest only when the source provides/retrieval layer
computes one. Portal event fields can supply correlation metadata: `EventEnvelope` already defines
`correlation_id`, `request_id`, `operation_id`, `evidence_id`, `source`, `source_version`, and
`resource`; these IDs do not themselves resolve to evidence bytes. Do not treat a Portal operation
event or Kubernetes Event as a data-provider record.

## 4. State and error semantics — PROPOSED

Each provider-backed facet (classification, policy, quality, lifecycle, lineage, promotion) has
`state: available | stale | unknown | unavailable` plus `observedAt`, `source`, and
`evidenceRefs`. `available` means the provider returned a value; it does not mean compliant.
Policy/quality verdicts, when actually supplied, use `pass | fail | warning | unknown`; lifecycle
uses provider-defined state plus `unknown` and must preserve the provider's raw state in
`providerState`.

| Condition | Required representation | Forbidden interpretation |
|---|---|---|
| Provider returns current record | `available` with observation time and source evidence | Calling it compliant without a verdict field |
| Provider returns a record older than adapter freshness threshold | `stale` and retain its timestamp | Presenting stale data as current/healthy |
| Provider omits a field or relationship | `unknown`, no evidence ref for the missing fact | Defaulting classification to `public`, quality to pass, or retention to inactive |
| Provider not configured / no adapter | `unavailable`, source name, observation time null | Empty inventory presented as proof that no governed data exists |
| Provider request unauthorized | `unavailable`; preserve sanitized status/reason code | Returning records outside caller scope or echoing credentials |
| Provider timeout/network/server failure | `unavailable`; sanitized error class and retryable flag if known | Reusing partial response as a complete catalog snapshot |
| Malformed provider record or unresolved edge endpoint | reject that record/edge; expose `unknown`/partial provider state and validation reason | Guessing an entity ID from display name |

No absence, empty result, failed fetch, or unknown field is evidence of compliance. Do not cache an
incomplete provider snapshot as complete; the existing scorecard already models unavailable rules
separately from failed rules (`unavailableRuleIds`, `evaluationComplete` in
`src/app/api/scorecards/route.ts`).

## 5. Scope and visibility contract

`scope` is part of both entity and evidence identity. Before lookup, aggregation, caching, or
serialization, a future catalog adapter must authorize the caller against the entity's
`clusterId` and namespace/team/tenant dimensions. The current `getEffectiveScope` resolves
cluster-admin or configured namespace/project visibility (`src/lib/scope.ts`); it does not define
a tenant ID or data-product authorization policy. Therefore:

1. Reuse existing Portal namespace/project visibility only for records whose provider mapping to
   those dimensions is explicit.
2. For a tenant-scoped record with no verified caller-to-tenant mapping, deny/omit the record and
   return a scope-safe authorization result; never fall back to cluster-wide visibility.
3. Include the effective scope fingerprint in any future cache key. Existing `scope.fingerprint`
   is the established scoped-cache dimension, not a data tenant identifier.
4. Apply scope before calculating totals or counts, matching the existing catalog and scorecard
   route behavior (`src/app/api/catalog/route.ts`, `src/app/api/scorecards/route.ts`).

These are requirements for a future implementation, not claims that current catalog endpoints
provide data-catalog tenant isolation.

## 6. Decision record

- **D1 — Separate data entities from `CatalogService`.** The latter describes Argo CD applications;
  reusing its name/namespace/owner as dataset truth would conflate deployment metadata and data
  governance.
- **D2 — Require provider-native IDs and explicit edges.** This makes identity and lineage
  auditable; display-name matching is ambiguous and therefore cannot establish a relationship.
- **D3 — Make missing evidence a first-class state.** `unknown`, `stale`, and `unavailable` prevent
  empty or failed provider reads from looking compliant.
- **D4 — Reuse Portal correlation/evidence identifiers only as references.** Existing event
  envelope IDs support cross-event correlation but do not imply an evidence store exists.
- **D5 — Mark provider integrations and new governance facets PROPOSED.** Current code exposes
  Argo CD, Kubernetes, service scorecard, cost, and operational event metadata; the data-governance
  sources named in the issue are not integrated in this repository.

## 7. Explicitly out of scope

This contract does not define endpoints, environment variables, source namespaces, provider
credentials, data ingestion jobs, policy evaluation, classification assignment rules, legal-hold
operations, deletion/restore workflows, evidence export/replay mechanics, or live integration
behavior. These require provider-owned contracts and implementation work. Any future provider
name, native identifier format, freshness threshold, classification authority, or tenant mapping
must be verified against the companion Narwhal source and labeled `PROPOSED` until adopted there.
