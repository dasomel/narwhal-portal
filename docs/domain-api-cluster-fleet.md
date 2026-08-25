# Domain API — Cluster/Fleet (portal#46 pilot)

- **Status**: Pilot / partial (one domain object of 10+ requested)
- **Date**: 2026-08-25
- **Related**: portal#46 (Unified Domain API / Management Model), portal#21 (Multi-Cluster
  Registration — `src/types/cluster.ts`, `src/lib/cluster-registry.ts`), portal#11 (Canonical
  Event/Operation Context — `src/lib/operation-context.ts`, `src/types/event-envelope.ts`),
  narwhal#42 (Management API/Event Contract)
- **Code**: `src/lib/domain/cluster.ts`, `src/lib/domain/cluster.fixtures.ts`,
  `src/app/api/domain/clusters/route.ts`

## 1. Scope

portal#46 asks for a provider-independent domain model across Cluster/Fleet,
Service/Application/Workload, Team/Tenant, GitOps state, Operation/Change, Policy,
Incident/Alert, Storage, Supply-chain, Identity, and Evidence — 10+ categories. That is
RFP-scale work spanning most of the Portal's surface area. This document and its accompanying
code cover **one pilot domain object — `Cluster`/`Fleet`** — chosen because portal#21 already
built the registry layer it sits on top of. The other 9+ categories are **explicitly out of
scope** for this pass; see §5.

This doubles as the "documented Domain API model" acceptance criterion — a doc-comment block at
the top of `src/lib/domain/cluster.ts` would have satisfied the issue's minimum bar, but this
repo already has a `docs/` directory with an established ADR-ish convention (see
`docs/adr-cost-basis.md`), so a real doc file was the better fit.

## 2. Domain shape vs. raw K8s-API shape

The Portal already has a K8s-shaped adapter: `GET /api/cluster` returns `ClusterInfra`
(`src/app/api/cluster/route.ts`) — node/pod/namespace inventory with field names lifted
directly from the K8s API (`metadata.name`, `status.conditions`, `nodeInfo.kubeletVersion`).
That route is unchanged by this pilot and keeps serving the infra-detail view.

The **domain shape**, `ClusterDomainObject` (`src/lib/domain/cluster.ts`), is a different,
smaller projection meant for fleet-level views:

| Domain field | Raw K8s equivalent | Why it differs |
|---|---|---|
| `health: ClusterHealthStatus` | derived from `/api/v1/nodes[].status.conditions` | one word (`healthy`/`degraded`/`offline`/`unknown`), not a per-node condition array — computed once via `deriveClusterHealth` (portal#21, reused here) |
| `capabilities: Record<capability, ClusterCapabilityState>` | no K8s equivalent | capability discovery is a Narwhal-platform concept (does this cluster run ArgoCD/metrics/events/storage/rbac/logs), not a K8s resource |
| `resource: EventResource` | no K8s equivalent | ties the domain object into the portal#11 event/operation/evidence envelope (`{ cluster: id }`) so it can be embedded in an operation record without re-deriving a resource ref |
| `freshness: DomainFreshness` | none (raw route caches silently) | explicit `asOf`/`source`/`cacheAgeSeconds` — see §4 |
| *(absent)* `nodes`, `controlPlane`, `namespaces` | `ClusterInfra`'s entire payload | vendor(K8s)-specific inventory stays in the K8s adapter; the domain object answers "is this cluster there and trustworthy," not "what pods are running" |

No K8s field name ever appears on `ClusterDomainObject` — verified in `cluster.test.ts`
("no raw K8s field names leak into the domain shape").

## 3. Capability discovery semantics

Four statuses, matching the issue's own vocabulary exactly: `supported`, `partial`,
`unavailable`, `not-applicable`. `deriveCapabilityState` (`src/lib/domain/cluster.ts`) computes
one per capability (`argocd`, `metrics`, `events`, `storage`, `rbac`, `logs` — the same set
`ClusterCapabilityProfile` already declares) via four branches, evaluated in this order:

1. **Declared `not-applicable` always wins.** A cluster the fleet operator registered as never
   running ArgoCD stays `not-applicable` even if the API server is reachable and authenticated.
   A capability the operator says doesn't apply cannot be "discovered" into existing.
2. **Cluster unreachable → every other capability degrades to `unavailable`.** No live evidence,
   no claim of support — the same "no false-green" convention `deriveClusterHealth` established
   in portal#21.
3. **Cluster reachable but not authenticated → `partial`.** We know the control plane is up but
   can't verify capability-level access (most of these are RBAC-gated), so the registry's
   declared value can't be confirmed true right now.
4. **Cluster reachable AND authenticated → the registry's declared value passes through
   unchanged**, with `source: "registry"`. This module deliberately does **not** probe
   ArgoCD/metrics/events/storage/logs endpoints individually (see §5) — trusting the fleet
   operator's declaration once basic liveness+auth is confirmed live is the honest middle ground
   between "never verify anything" and "probe every OSS system," which is out of reach for one
   pilot pass.

Each `ClusterCapabilityState` also carries `source` (`"registry"` or `"live-probe"`) so a
consumer can distinguish "this is what was declared at registration time" from "this is what the
live probe itself determined" — the two `source` values line up with branches 1/4 vs. 2/3 above.

## 4. Freshness / source metadata

Every `ClusterDomainObject` carries a `freshness: DomainFreshness`:

```ts
interface DomainFreshness {
  asOf: string                 // ISO timestamp the projection was computed
  source: "registry" | "live-probe" | "cache" | "fixture"
  cacheAgeSeconds: number | null  // set on a cache hit, else null
}
```

`GET /api/domain/clusters` caches each cluster's projection at `cluster:{id}:domain` (30s TTL,
via `cacheGet`/`cacheSet` — cache failure is non-fatal, per this repo's standing convention). On
a cache hit, the route recomputes `freshness` (`source: "cache"`, `cacheAgeSeconds` from the
stored `cachedAt`) rather than serving a stale freshness stamp — a consumer should never be able
to mistake a 25-second-old cached projection for a projection computed just now.

## 5. Explicitly out of scope

- **The other 9+ domain object categories** (Service/Application/Workload, Team/Tenant, GitOps
  state, Operation/Change, Policy, Incident/Alert, Storage, Supply-chain, Identity,
  Evidence) — not started. `Cluster`/`Fleet` is the one pilot.
- **Capability discovery for OSS systems this repo doesn't yet talk to.** `probeClusterHealth`
  only probes the K8s API server's `/version` endpoint (reachability + auth + version) — it does
  **not** make a live call to ArgoCD, Alertmanager, or any storage/logging backend to verify
  those specific capabilities. See §3 branch 4.
- **Live verification against a real second cluster or a real degraded-dependency scenario.**
  The only cluster this portal has ever registered (Kakao Cloud, portal#21's `primary`) was
  destroyed 2026-08-10 and has not been recreated this session. Everything demonstrating
  "unreachable cluster" behavior in this pass is fixture-based
  (`src/lib/domain/cluster.fixtures.ts`), not observed against a live degraded cluster.
- **API contract compatibility tests against a live Narwhal Management API.** narwhal#42 (the
  paired cluster-side issue) is, as of this session, a static schema/CLI skeleton — not a
  running server this portal could hit. "Define compatibility/versioning rules" and "API
  contract tests verify compatibility" (two of the issue's acceptance criteria) have no live
  counterpart to test against yet; `ClusterDomainSchemaVersion` exists as a placeholder
  (`"1.0"`) but no compatibility-test harness was built.
- **Mutations.** This pilot is read-only (`GET /api/domain/clusters`). The issue's "Portal
  mutations resolve to canonical operations" criterion is unaddressed here — there is no
  cluster-domain mutation route in this pass.
- **Retrofitting existing dashboard pages** to consume the domain shape instead of `ClusterInfra`
  — the new route is additive, not a replacement (see §1).
