/**
 * Single cache-key contract (#53).
 *
 * Every Valkey key in this repo used to be a hand-written template string next
 * to its `cacheGet`/`cacheSet` call. That made it easy for a new route to copy
 * an existing pattern minus the one dimension that actually mattered — #49
 * (Keycloak) and #133 (cost cache) were both "cache key missing a scope
 * dimension" bugs found after the fact. This module is the one place a cache
 * key is assembled from explicit named dimensions plus a schema version, and
 * `CACHE_NAMESPACES` is the documented contract (dimensions / TTL /
 * invalidation trigger / partial-caching) that `cache-keys.contract.test.ts`
 * enforces for every namespace.
 *
 * Two primitives are NOT reinvented here — they already own a dimension each
 * and are reused as-is:
 * - `EffectiveScope.fingerprint` (src/lib/scope.ts, built by
 *   `scopeFingerprint` in src/lib/role-filter.ts) folds groups/teams/cluster
 *   and, where resolved, the visible-namespace set into one opaque string —
 *   this is the "authorization scope" dimension.
 * - `clusterCacheKey` (src/lib/cluster-registry.ts) already builds
 *   `cluster:{cluster_id}:{resource}` per the issue's own key shape — this is
 *   the "cluster" dimension for the two multi-cluster-aware routes.
 *
 * Migration rule: every builder below reproduces the exact key string the
 * call site used before this module existed (verified 1:1 against the prior
 * template literals). Nothing here changes an effective key today. A future
 * change that must bump a namespace's shape does so by adding a version
 * segment to that one builder — deliberately, and noted in
 * `CACHE_NAMESPACES` — never by editing the join order silently.
 * Valkey freshness metadata uses a derived `:meta` sibling key, not a separately registered namespace.
 *
 * Registry granularity: every `cacheKeys` builder has its OWN `CACHE_NAMESPACES`
 * entry — even builders that share a common key prefix (e.g. the twelve
 * `k8s:*` cluster-state caches) get separate entries, because
 * `cache-keys.contract.test.ts` asserts each builder's dimensions
 * (`BUILDER_CHECKS[name].dimensionArgIndex`) are EXACTLY the dimension set its
 * registry entry declares. A shared aggregate entry can't satisfy that for
 * builders with different dimension counts (a still-namespaced `promCluster`
 * builder that only takes a `cluster_id` can't equal a `promQuery` entry that
 * also takes a `query`), so one entry per builder is the only shape where
 * "the registry says X dimensions" and "the builder actually varies by X
 * dimensions" can be mechanically the same claim.
 *
 * Out of scope for this module (left as-is, not duplicated):
 * - `KEYCLOAK_CACHE_KEYS` / `invalidateKeycloakCaches` (src/lib/keycloak-client.ts)
 *   already centralize the `keycloak:*` / `api:groups-enriched` keys per #49.
 * - `src/lib/argocd.ts`, `src/lib/gitea.ts`, `src/lib/http-client.ts` retain
 *   their existing key shapes; ArgoCD mutation routes still participate in
 *   the registry-driven invalidation contract below.
 */

/** Named dimensions a cache key may legitimately depend on. */
export type CacheDimension =
  | "namespace" // Kubernetes namespace being read (access-gated before the cache lookup, not per-caller data)
  | "cluster" // cluster_id, via clusterCacheKey
  | "scope" // EffectiveScope.fingerprint — groups/teams/cluster/(resolved namespaces)
  | "user" // caller subject (OIDC sub), used alongside `scope` where the response is per-user (e.g. My Apps)
  | "role" // caller's role name, where the response content itself differs by role
  | "query" // caller-supplied query/filter parameters (PromQL, service id, pagination, ...)
  | "version" // explicit schema version segment

const SCOPE_LIKE_DIMENSIONS: readonly CacheDimension[] = ["scope", "user", "role", "cluster"]

export function isScopeLikeDimension(d: CacheDimension): boolean {
  return SCOPE_LIKE_DIMENSIONS.includes(d)
}

/**
 * Why a namespace with no scope-like dimension is still safe — a closed set
 * instead of free text so a reviewer (and the type checker) can tell a real
 * reason from a plausible-sounding excuse. Derived from the reasons actually
 * used below; add a case here (not a new free-text string) if a future
 * namespace needs a genuinely new justification.
 */
export type UnscopedReasonCode =
  /** namespaceVisible()/equivalent is checked on every request before the cache lookup — the cached value itself never varies by caller, only whether they may read it does. */
  | "gate-then-serve"
  /** The route that reads/writes this key requires an admin-only role (requireRole('cluster-admin') / requireAdmin()); every caller who can reach it sees the same value. Verified cheaply where `ownerPath` is set. */
  | "admin-only-route"
  /** Cluster/platform-wide state with no per-caller variance at all — same value for every authenticated caller regardless of identity, team, or role. */
  | "cluster-wide-state"
  /** This cache holds the unfiltered upstream response; per-caller filtering happens downstream, after the cache read, in a route/module that carries its own scope dimension. */
  | "downstream-filtered"
  /** Keyed by an immutable content hash/identifier (e.g. a commit SHA) — content-addressed, so there is no caller identity to leak across. */
  | "content-addressed"
  /** Key/invalidation already centralized in another module, or the file is excluded from this migration slice — documented here for completeness only. */
  | "owned-elsewhere"

export interface UnscopedReason {
  code: UnscopedReasonCode
  /** Optional namespace-specific detail beyond what the code already says. */
  detail?: string
}

export interface CacheNamespaceSpec {
  /** Example or literal key for this namespace, as it appears on the wire. */
  example: string
  /** Dimensions folded into this namespace's key. */
  dimensions: CacheDimension[]
  ttlSeconds: number | "varies"
  /** Owning module (not necessarily migrated to a builder below — see file header). */
  owner: string
  /**
   * Single canonical file path for `ownerPath`-verifiable codes
   * (`admin-only-route`, `gate-then-serve`) — `cache-keys.contract.test.ts`
   * greps this file for the expected guard so the claim is checked, not just
   * asserted. Omitted where the check isn't cheap (multi-file owners,
   * non-migrated namespaces) — see `UnscopedReasonCode`'s doc for why that's
   * an accepted gap, not a silent one.
   */
  ownerPath?: string
  /** What mutation/event invalidates or expires this entry. */
  invalidation: string
  /** Mutation events that make this projection stale. */
  invalidationTriggers?: CacheInvalidationEvent[]
  /** Valkey glob patterns used to purge every key in this namespace. */
  invalidationPatterns?: string[]
  /** Whether a failed or partial provider response is ever cached under this namespace. */
  cachesPartial: boolean
  /**
   * True when the cached VALUE differs by caller identity/team/cluster and
   * therefore MUST carry a `scope`, `user`, `role`, or `cluster` dimension to
   * avoid cross-tenant leakage. False means the namespace is gated (access
   * checked before every cache lookup, e.g. namespaceVisible) or is a single
   * cluster-admin-only global view where the value never varies by caller.
   */
  securitySensitive: boolean
  /**
   * Required when `dimensions` has no scope-like dimension (`scope`/`user`/
   * `role`/`cluster`): why that's safe. Checked unconditionally by
   * `cache-keys.contract.test.ts` for every entry, independent of
   * `securitySensitive` — a hand-set flag alone made an earlier version of
   * this test tautological (it only ever checked entries someone remembered
   * to flag). Entries that DO have a scope-like dimension don't need this.
   */
  unscopedReason?: UnscopedReason
  note?: string
}

export type CacheInvalidationEvent =
  | "iam.changed"
  | "namespace.changed"
  | "cluster.changed"
  | "argocd.app.changed"
  | "apisix.route.changed"
  | "alert.silence.changed"
  | "certificate.renewed"
  | "node.tuning.changed"
  | "event.ingested"

function join(...parts: Array<string | number | boolean | undefined | null>): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== "").join(":")
}

/**
 * Builders, one per namespace this slice migrated. Each reproduces the exact
 * pre-existing key string — see CACHE_NAMESPACES for the documented contract
 * and the file header for the 1:1 preservation rule.
 */
export const cacheKeys = {
  myApps: (userSub: string, scopeFingerprint: string) => join("my-apps", userSub, scopeFingerprint),
  routesList: () => "api:routes-list",
  // `join` intentionally not used — `service` is "" for "all services" and the
  // pre-existing key keeps that as a bare trailing colon rather than collapsing it.
  traces: (service: string) => `traces:${service}`,
  toolsHealth: (role: string) => join("tools", "health", role),
  architectureTopology: () => "architecture:topology",

  k8sPods: (namespace: string, app: string | undefined) => join("k8s", "pods", namespace, app ?? "all"),
  k8sEvents: (namespace: string, name: string) => join("k8s", "events", namespace, name),
  k8sResource: (namespace: string, name: string) => join("k8s", "resource", namespace, name),
  podsList: (namespace: string, instance: string | undefined) => join("pods", "list", namespace, instance ?? "all"),
  // `join` intentionally not used here — `container` can legitimately be "" (no
  // container filter), and the pre-existing key keeps that as an embedded empty
  // segment rather than collapsing it.
  podsLogs: (namespace: string, pod: string, container: string, tailLines: number, previous: boolean) =>
    `pods:logs:${namespace}:${pod}:${container}:${tailLines}:${previous}`,

  governanceRbacV2: () => "governance:rbac:v2",
  // #147: scoped per caller now — non-admins reach this route too, and the
  // response is filtered to their effective scope (see the route comment).
  governanceResourcesV3: (scopeFingerprint: string) => join("governance", "resources", "v3", scopeFingerprint),
  governanceDistributionV2: () => "governance:distribution:v2",
  // #144: this endpoint moved from a literal audit trail to an explicitly-labeled
  // "operational events" feed (portal#16) — new key, new response shape (no `actor`).
  governanceOperationalEventsV2: () => "governance:operational-events:v2",
  governanceOperationalEventsV3: () => "governance:operational-events:v3",
  governanceDoraV2: (scopeFingerprint: string) => join("governance", "dora", "v2", scopeFingerprint),
  governanceScorecard: (scopeFingerprint: string) => join("governance", "scorecard", scopeFingerprint),

  eventsTimeline: (scopeFingerprint: string) => join("events", "timeline", scopeFingerprint),

  falcoEvents: (priority: string | undefined, sinceMinutes: number, limit: number) =>
    join("falco", "events", priority ?? "all", sinceMinutes, limit),
  falcoCritical: () => "falco:critical",

  kisaComplianceList: () => "compliance:kisa:list",

  heroSummary: () => "hero:summary",

  costV2: (scope: "cluster" | "namespace" | "service", scopeFingerprint: string, pricingKey: string) =>
    join("cost", "v2", scope, scopeFingerprint, pricingKey),
  costServiceV2: (scopeFingerprint: string, serviceNamespace: string, serviceId: string, pricingKey: string) =>
    join("cost", "service", "v2", scopeFingerprint, serviceNamespace, serviceId, pricingKey),
  costTrendV2: (
    scope: "cluster" | "namespace" | "service",
    scopeFingerprint: string,
    serviceNamespace: string | undefined,
    id: string,
    days: number,
    pricingKey: string
  ) =>
    // `join` intentionally not used here: the pre-existing key keeps an EMPTY
    // segment (a bare "::") when serviceNamespace is undefined — dropping it
    // would shift every other position and invalidate every cluster/service-scope
    // trend entry on deploy.
    `cost:trend:v2:${scope}:${scopeFingerprint}:${serviceNamespace ?? ""}:${id}:${days}:${pricingKey}`,

  apisixRoutes: () => "apisix:routes",

  promQuery: (clusterId: string, promql: string) => join("prom", clusterId, promql),
  promVector: (clusterId: string, promql: string) => join("promv", clusterId, promql),
  promRange: (clusterId: string, promql: string, durationMinutes: number) => join("promr", clusterId, promql, durationMinutes),
  promNodeMetrics: (clusterId: string) => join("promnodemetrics", clusterId),
  promCluster: (clusterId: string) => join("promcluster", clusterId),

  platformStatus: () => "status:platform",

  trivySummary: () => "security:summary",
  trivyWorkloads: () => "security:workloads",
  trivyImage: (image: string) => join("security", "image", image),
  trivyTopVulnerable: (limit: number) => join("security", "top-vulnerable", limit),

  scorecardRules: () => "scorecard:rules",
  scorecardDetail: (rulesVersion: number, serviceId: string) => join("scorecard", "detail", rulesVersion, serviceId),
  // `join` intentionally not used here either — the trailing empty segment
  // (bare trailing ":") when tierFilter is undefined is the pre-existing shape.
  scorecardAll: (rulesVersion: number, tierFilter: string | undefined) => `scorecard:all:${rulesVersion}:${tierFilter ?? ""}`,

  openbaoSecrets: () => "openbao:secrets",

  alertmanagerActive: () => "alerts:active",

  complianceConfigAuditList: () => "compliance:config-audit:list",
  complianceConfigAuditDetail: (namespace: string, name: string) => join("compliance", "config-audit", namespace, name),
  complianceRbacAuditList: () => "compliance:rbac-audit:list",
  complianceRbacAuditDetail: (namespace: string, name: string) => join("compliance", "rbac-audit", namespace, name),
  complianceInfraAuditList: () => "compliance:infra-audit:list",
  complianceInfraAuditDetail: (node: string) => join("compliance", "infra-audit", node),
  complianceFrameworksList: () => "compliance:frameworks:list",
  complianceFrameworksDetail: (id: string) => join("compliance", "frameworks", id),
  complianceSummary: () => "compliance:summary",

  serviceGraphCluster: (window: string, namespace: string | undefined) => join("graph", "cluster", window, namespace ?? "all"),
  serviceGraphSvc: (serviceId: string, window: string) => join("graph", "svc", serviceId, window),

  k8sCniPlugin: () => "k8s:cni-plugin",
  k8sKubeletConfig: (nodeName: string) => join("k8s", "kubelet-config", nodeName),
  k8sNamespaces: () => "k8s:namespaces",
  k8sRbac: () => "k8s:rbac",
  k8sEventsAll: (namespace: string | undefined) => join("k8s", "events", namespace ?? "all"),
  k8sCerts: () => "k8s:certs",
  k8sKyverno: () => "k8s:kyverno",
  k8sApiserverPods: () => "k8s:apiserver-pods",
  k8sNodeReadiness: () => "k8s:node-readiness",
  k8sControlPlaneHealth: () => "k8s:control-plane-health",
  k8sNetpol: () => "k8s:netpol",
  k8sNode: (name: string) => join("k8s", "node", name),

  // portal#47: aggregate dependency-health snapshot cache — see dependency-health.ts's
  // getDependencyHealthSnapshot(). No dimension: /api/health/dependencies is
  // cluster-admin-only (same value for every admin) and the snapshot covers every
  // dependency in one key, not one per dependency.
  healthDependencies: () => "health:dependencies",
  healthSummary: () => "health:summary",
  liveK8sInformerLease: () => "live:k8s-informer:lease",
} as const

/**
 * The documented contract: every cache namespace in the codebase, whether or
 * not it was migrated to a `cacheKeys` builder above. `cache-keys.contract.test.ts`
 * asserts, for every entry with a matching `BUILDER_CHECKS` builder, that
 * `dimensions` here EQUALS that builder's declared dimension set exactly.
 */
export const CACHE_NAMESPACES: Record<string, CacheNamespaceSpec> = {
  "my-apps": {
    example: "my-apps:{userSub}:{scopeFingerprint}",
    dimensions: ["user", "scope"],
    ttlSeconds: 15,
    owner: "src/app/api/my-apps/route.ts",
    invalidation: "prefix purge on IAM, namespace, cluster, or ArgoCD app changes",
    invalidationTriggers: ["iam.changed", "namespace.changed", "cluster.changed", "argocd.app.changed"],
    invalidationPatterns: ["my-apps:*"],
    cachesPartial: false,
    securitySensitive: true,
    note: "Response is the caller's own apps/deploys/alerts — must not be served to a different user or scope.",
  },
  "api:routes-list": {
    example: "api:routes-list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/app/api/settings/routes/route.ts",
    ownerPath: "src/app/api/settings/routes/route.ts",
    invalidation: "cacheDel on POST (route create/update)",
    invalidationTriggers: ["apisix.route.changed"],
    invalidationPatterns: ["api:routes-list"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "admin-only-route", detail: "requireAdmin()-gated; identical route list for every admin." },
  },
  traces: {
    example: "traces:{service}",
    dimensions: ["query"],
    ttlSeconds: 15,
    owner: "src/app/api/traces/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Tempo trace search results, not per-caller; `service` is a query filter, not an identity." },
  },
  "tools:health": {
    example: "tools:health:{role}",
    dimensions: ["role"],
    ttlSeconds: 30,
    owner: "src/app/api/tools/health/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
    note: "Tool visibility/health differs by role — role must stay in the key.",
  },
  "architecture:topology": {
    example: "architecture:topology",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/app/api/architecture/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide topology, same for every authenticated caller." },
  },
  "k8s:pods": {
    example: "k8s:pods:{namespace}:{app|all}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/pods/route.ts",
    ownerPath: "src/app/api/k8s/pods/route.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["k8s:pods:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "gate-then-serve",
      detail: "namespaceVisible() is checked on every request before the cache lookup, so the pod list itself never varies by caller — only whether they may read it does.",
    },
  },
  "k8s:events (per-resource)": {
    example: "k8s:events:{namespace}:{name}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/events/route.ts",
    ownerPath: "src/app/api/k8s/events/route.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["k8s:events:*"],
    cachesPartial: false,
    securitySensitive: false,
    // #145 fixed the gap this entry used to describe: namespaceVisible() is
    // now checked before the cache lookup, same as /api/k8s/pods and
    // /api/k8s/resource — so this is gate-then-serve like its siblings now.
    unscopedReason: {
      code: "gate-then-serve",
      detail: "namespaceVisible() is checked on every request before the cache lookup (portal#145), same as /api/k8s/pods and /api/k8s/resource.",
    },
  },
  "k8s:resource": {
    example: "k8s:resource:{namespace}:{name}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/resource/route.ts",
    ownerPath: "src/app/api/k8s/resource/route.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["k8s:resource:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "gate-then-serve", detail: "Gate-then-serve, same as k8s:pods." },
  },
  "pods:list": {
    example: "pods:list:{namespace}:{instance|all}",
    dimensions: ["namespace"],
    ttlSeconds: 15,
    owner: "src/app/api/pods/route.ts",
    ownerPath: "src/app/api/pods/route.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["pods:list:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "gate-then-serve", detail: "Gate-then-serve (portal#33): namespaceVisible() checked before every cache lookup." },
  },
  "pods:logs": {
    example: "pods:logs:{namespace}:{pod}:{container}:{tailLines}:{previous}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 5,
    owner: "src/app/api/pods/[namespace]/[pod]/logs/route.ts",
    ownerPath: "src/app/api/pods/[namespace]/[pod]/logs/route.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["pods:logs:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "gate-then-serve", detail: "Gate-then-serve, same as pods:list." },
  },
  "governance:rbac:v2": {
    example: "governance:rbac:v2",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/app/api/governance/rbac/route.ts",
    ownerPath: "src/app/api/governance/rbac/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "admin-only-route", detail: "requireRole('cluster-admin') gate; identical value for every cluster-admin." },
  },
  "governance:resources:v3": {
    example: "governance:resources:v3:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 30,
    owner: "src/app/api/governance/resources/route.ts",
    invalidation: "prefix purge on IAM or namespace changes",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["governance:resources:v3:*"],
    cachesPartial: false,
    securitySensitive: true,
    note: "#147: scoped per caller — non-admins reach this route too (nav gates to cluster-admin/developer/viewer, not admin-only), so the response is filtered to the caller's effective scope and the key carries scope.fingerprint.",
  },
  "governance:distribution:v2": {
    example: "governance:distribution:v2",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/app/api/governance/distribution/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "auth()-gated (not admin-specific) global cluster resource view, identical for every authenticated caller." },
  },
  "governance:operational-events:v2": {
    example: "governance:operational-events:v2",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/governance-operational-events.ts",
    ownerPath: "src/lib/governance-operational-events.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "admin-only-route", detail: "requireRole('cluster-admin') gate; identical value for every cluster-admin." },
    note: "#144 (portal#16): renamed from governance:audit — this is an operational-events feed, not an audit trail.",
  },
  "governance:operational-events:v3": {
    example: "governance:operational-events:v3",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/governance-operational-events.ts",
    ownerPath: "src/lib/governance-operational-events.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "admin-only-route", detail: "requireRole('cluster-admin') gate; identical value for every cluster-admin." },
    note: "Operational Kubernetes Events include bounded-list truncation metadata; shared by the deprecated audit alias.",
  },
  "governance:dora:v2": {
    example: "governance:dora:v2:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 120,
    owner: "src/app/api/governance/dora/route.ts",
    invalidation: "prefix purge on IAM or namespace changes",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["governance:dora:v2:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "governance:scorecard": {
    example: "governance:scorecard:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 30,
    owner: "src/app/api/governance/scorecard/route.ts",
    invalidation: "prefix purge on IAM or namespace changes",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["governance:scorecard:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "events:timeline": {
    example: "events:timeline:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 15,
    owner: "src/app/api/events/route.ts",
    invalidation: "prefix purge on IAM changes; event data expires after 15 seconds",
    // High-frequency producers must not trigger pattern invalidation; TTL covers it.
    invalidationTriggers: ["iam.changed"],
    invalidationPatterns: ["events:timeline:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "cluster:{id}:infra": {
    example: "cluster:{clusterId}:infra",
    dimensions: ["cluster"],
    ttlSeconds: 30,
    owner:
      "src/app/api/cluster/route.ts (writer) + src/app/(dashboard)/security/page.tsx (reader) — both via clusterCacheKey, src/lib/cluster-registry.ts",
    invalidation: "prefix purge on cluster registry changes",
    invalidationTriggers: ["cluster.changed"],
    invalidationPatterns: ["cluster:*:infra"],
    cachesPartial: false,
    securitySensitive: true,
    note:
      "Multi-cluster (portal#21): must not serve cluster A's infra under cluster B's request. Found while writing this contract: security/page.tsx read the literal 'cluster:infra' (pre-#21 shape) and had never matched this writer's clusterCacheKey(clusterId,'infra') key since #21 shipped — a permanent cache miss, fixed here to use the same builder.",
  },
  "cluster:{id}:domain": {
    example: "cluster:{clusterId}:domain",
    dimensions: ["cluster"],
    ttlSeconds: 30,
    owner: "src/app/api/domain/clusters/route.ts (key via clusterCacheKey)",
    invalidation: "prefix purge on cluster registry changes",
    invalidationTriggers: ["cluster.changed"],
    invalidationPatterns: ["cluster:*:domain"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "falco:events": {
    example: "falco:events:{priority|all}:{sinceMinutes}:{limit}",
    dimensions: ["query"],
    ttlSeconds: 30,
    owner: "src/lib/falco.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide runtime security events, not per-caller." },
  },
  "falco:critical": {
    example: "falco:critical",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/falco.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide runtime security events, not per-caller." },
  },
  "compliance:kisa:list": {
    example: "compliance:kisa:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/kisa.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide KISA control status, not per-caller." },
  },
  "hero:summary": {
    example: "hero:summary",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/hero.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide dashboard summary, not per-caller." },
  },
  "cost:v2": {
    example: "cost:v2:{scope}:{scopeFingerprint}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 300,
    owner: "src/lib/cost.ts",
    invalidation: "prefix purge on IAM or namespace changes; TTL otherwise",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["cost:v2:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "cost:service:v2": {
    example: "cost:service:v2:{scopeFingerprint}:{serviceNamespace}:{serviceId}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 300,
    owner: "src/lib/cost.ts",
    invalidation: "prefix purge on IAM or namespace changes; TTL otherwise",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["cost:service:v2:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "cost:trend:v2": {
    example: "cost:trend:v2:{scope}:{scopeFingerprint}:{serviceNamespace}:{id}:{days}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 3600,
    owner: "src/lib/cost.ts",
    invalidation: "prefix purge on IAM or namespace changes; TTL otherwise",
    invalidationTriggers: ["iam.changed", "namespace.changed"],
    invalidationPatterns: ["cost:trend:v2:*"],
    cachesPartial: false,
    securitySensitive: true,
  },
  "apisix:routes": {
    example: "apisix:routes",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/apisix-client.ts",
    invalidation: "cacheDel on route mutation",
    invalidationTriggers: ["apisix.route.changed"],
    invalidationPatterns: ["apisix:routes"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "cluster-wide-state",
      detail: "getRoutes() itself has no auth gate — its only current caller (settings/routes/route.ts) is requireAdmin()-gated, but that guarantee lives in the caller, not here, so this is documented as cluster-wide rather than admin-only-route.",
    },
  },
  "prom:query": {
    example: "prom:{clusterId}:{promql}",
    dimensions: ["cluster", "query"],
    ttlSeconds: 15,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only; provider fetch failures ('unavailable') are not cached, only genuine zero-series ('empty') results are",
    cachesPartial: false,
    securitySensitive: false,
    note: "PromQL itself already encodes any caller-scope filtering (see cost.ts's scopeNamespaceMatcher usage) at the query-string level, which is why `query` — not `scope` — is the second dimension here; `cluster` covers multi-cluster isolation.",
  },
  "prom:vector": {
    example: "promv:{clusterId}:{promql}",
    dimensions: ["cluster", "query"],
    ttlSeconds: 15,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only; provider fetch failures ('unavailable') are not cached, only genuine zero-series ('empty') results are",
    cachesPartial: false,
    securitySensitive: false,
  },
  "prom:range": {
    example: "promr:{clusterId}:{promql}:{durationMinutes}",
    dimensions: ["cluster", "query"],
    ttlSeconds: 30,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "prom:node-metrics": {
    example: "promnodemetrics:{clusterId}",
    dimensions: ["cluster"],
    ttlSeconds: 15,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "prom:cluster": {
    example: "promcluster:{clusterId}",
    dimensions: ["cluster"],
    ttlSeconds: 15,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "status:platform": {
    example: "status:platform",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/platform-status.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide platform status, not per-caller." },
  },
  "security:summary": {
    example: "security:summary",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide vulnerability data, not per-caller." },
  },
  "security:workloads": {
    example: "security:workloads",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide vulnerability data, not per-caller." },
  },
  "security:image": {
    example: "security:image:{image}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide vulnerability data, not per-caller." },
  },
  "security:top-vulnerable": {
    example: "security:top-vulnerable:{limit}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide vulnerability data, not per-caller." },
  },
  "scorecard:rules": {
    example: "scorecard:rules",
    dimensions: [],
    ttlSeconds: 300,
    owner: "src/lib/scorecard.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Rules ConfigMap projection, not per-caller." },
  },
  "scorecard:detail": {
    example: "scorecard:detail:{rulesVersion}:{serviceId}",
    dimensions: ["version", "query"],
    ttlSeconds: 300,
    owner: "src/lib/scorecard.ts",
    invalidation: "TTL only; keyed by the rules ConfigMap version so a rules change is a cache-key change, not an invalidation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "cluster-wide-state",
      detail: "Evaluation result is per-rules-version + per-service, not per-caller — every caller who can reach the route sees the same evaluation.",
    },
  },
  "scorecard:all": {
    example: "scorecard:all:{rulesVersion}:{tierFilter}",
    dimensions: ["version", "query"],
    ttlSeconds: 60,
    owner: "src/lib/scorecard.ts",
    invalidation: "TTL only; keyed by the rules ConfigMap version so a rules change is a cache-key change, not an invalidation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "cluster-wide-state",
      detail: "Evaluation results are per-rules-version + per-tier-filter, not per-caller.",
    },
  },
  "openbao:secrets": {
    example: "openbao:secrets",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/openbao.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Secret metadata only (paths/keys), never secret values, and not per-caller." },
  },
  "alerts:active": {
    example: "alerts:active",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/alertmanager.ts",
    invalidation: "cacheDel on silence create/delete",
    invalidationTriggers: ["alert.silence.changed"],
    invalidationPatterns: ["alerts:active"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "downstream-filtered",
      detail: "Cluster-wide Alertmanager feed; per-caller filtering happens downstream in my-apps/events, which carry their own scope dimension.",
    },
  },
  "compliance:config-audit:list": {
    example: "compliance:config-audit:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:config-audit:detail": {
    example: "compliance:config-audit:{namespace}:{name}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:rbac-audit:list": {
    example: "compliance:rbac-audit:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:rbac-audit:detail": {
    example: "compliance:rbac-audit:{namespace}:{name}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:infra-audit:list": {
    example: "compliance:infra-audit:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:infra-audit:detail": {
    example: "compliance:infra-audit:{node}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:frameworks:list": {
    example: "compliance:frameworks:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:frameworks:detail": {
    example: "compliance:frameworks:{id}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "compliance:summary": {
    example: "compliance:summary",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide compliance audit data, not per-caller." },
  },
  "graph:cluster": {
    example: "graph:cluster:{window}:{namespace|all}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/service-graph.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["graph:cluster:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide service dependency graph, not per-caller." },
    note: "Real TTL at the call site is a ternary (5s for the \"1m\" window, 60s otherwise), not this fixed number — see BUILDER_CHECKS.serviceGraphCluster and the call site comment in src/lib/service-graph.ts.",
  },
  "graph:svc": {
    example: "graph:svc:{serviceId}:{window}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/service-graph.ts",
    invalidation: "prefix purge on namespace changes",
    invalidationTriggers: ["namespace.changed"],
    invalidationPatterns: ["graph:svc:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster-wide service dependency graph, not per-caller." },
  },
  "k8s:cni-plugin": {
    example: "k8s:cni-plugin",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:kubelet-config": {
    example: "k8s:kubelet-config:{node}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:namespaces": {
    example: "k8s:namespaces",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "prefix purge on namespace or cluster changes",
    invalidationTriggers: ["namespace.changed", "cluster.changed"],
    invalidationPatterns: ["k8s:namespaces"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller; namespace visibility filtering happens downstream in role-filter.ts/scope.ts." },
  },
  "k8s:rbac": {
    example: "k8s:rbac",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "prefix purge on IAM or cluster changes",
    invalidationTriggers: ["iam.changed", "cluster.changed"],
    invalidationPatterns: ["k8s:rbac"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state; this is a cluster-admin surface gated at the route level, not in this cache." },
  },
  "k8s:events (namespace-list)": {
    example: "k8s:events:{namespace|all}",
    dimensions: ["query"],
    ttlSeconds: 15,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
    note: "Distinct from \"k8s:events (per-resource)\" above (built by /api/k8s/events, not this k8s-client.ts helper) — they share the `k8s:events` prefix, a pre-existing shape kept as-is per the migration rule.",
  },
  "k8s:certs": {
    example: "k8s:certs",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/k8s-client.ts",
    invalidation: "cache purge on certificate renewal",
    invalidationTriggers: ["certificate.renewed"],
    invalidationPatterns: ["k8s:certs"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:kyverno": {
    example: "k8s:kyverno",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:apiserver-pods": {
    example: "k8s:apiserver-pods",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:node-readiness": {
    example: "k8s:node-readiness",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "cache purge on node tuning",
    invalidationTriggers: ["node.tuning.changed"],
    invalidationPatterns: ["k8s:node-readiness", "k8s:node:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:control-plane-health": {
    example: "k8s:control-plane-health",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:netpol": {
    example: "k8s:netpol",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "k8s:node": {
    example: "k8s:node:{name}",
    dimensions: ["query"],
    ttlSeconds: 30,
    owner: "src/lib/k8s-client.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Cluster infrastructure state, not per-caller." },
  },
  "health:dependencies": {
    example: "health:dependencies",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/dependency-health.ts",
    ownerPath: "src/app/api/health/dependencies/route.ts",
    invalidation:
      "TTL only. Written ONLY when every probe in the snapshot reports state 'ok' " +
      "(getDependencyHealthSnapshot() in dependency-health.ts) — a mixed snapshot (any dependency partial/" +
      "stale/empty/unavailable/unauthorized) is never cached, matching this registry's project-wide rule that " +
      "no namespace caches a partial/failed provider response (see the contract test right below this one) and " +
      "#47's AC that a degraded dependency must not be masked by a stale-but-clean cached snapshot.",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "admin-only-route",
      detail: "requireRole('cluster-admin')-gated; identical dependency topology snapshot for every cluster-admin.",
    },
  },
  "health:summary": {
    example: "health:summary",
    dimensions: [],
    ttlSeconds: 20,
    owner: "src/lib/dependency-health.ts",
    ownerPath: "src/app/api/health/summary/route.ts",
    invalidation: "TTL only. Redacted aggregate shared by all authenticated users; failures are cached briefly to limit probe amplification.",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "Same redacted aggregate for every authenticated user; contains no per-user data." },
  },
  "live:k8s-informer:lease": {
    example: "live:k8s-informer:lease",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/live-k8s-informer.ts",
    invalidation: "Lease expiry or owner-token compare-and-delete",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "cluster-wide-state", detail: "One process-wide informer lease for the configured Kubernetes Events watch." },
  },
  "keycloak:* / api:groups-enriched": {
    example: "keycloak:users | keycloak:groups | keycloak:groups-detailed | api:groups-enriched",
    dimensions: [],
    ttlSeconds: "varies",
    owner: "src/lib/keycloak-client.ts (KEYCLOAK_CACHE_KEYS, already centralized per #49)",
    invalidation: "invalidateKeycloakCaches() on every membership/attribute mutation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "owned-elsewhere", detail: "Admin-facing user/group directory projections, not per-caller; key/invalidation already centralized in keycloak-client.ts." },
    note: "Not migrated to cacheKeys here — already owns its own centralized key/invalidation module; documented for completeness only.",
  },
  "argocd:apps / argocd:app:{name}": {
    example: "argocd:apps | argocd:app:{name}",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/argocd.ts (excluded from this slice)",
    invalidation: "prefix purge on ArgoCD app or namespace changes",
    invalidationTriggers: ["argocd.app.changed", "namespace.changed"],
    invalidationPatterns: ["argocd:apps", "argocd:app:*"],
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: {
      code: "downstream-filtered",
      detail: "Cluster-wide ArgoCD application state; per-caller filtering (appVisible) happens downstream at the route level, not in this cache.",
    },
    note: "Existing argocd.ts key shapes are retained; sync and rollback routes call the registry-driven invalidator.",
  },
  "dora:commit:{sha}": {
    example: "dora:commit:{sha}",
    dimensions: [],
    ttlSeconds: 3600,
    owner: "src/lib/gitea.ts (excluded from this slice)",
    invalidation: "TTL only (commit SHAs are immutable)",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: { code: "content-addressed", detail: "Keyed by immutable commit SHA — there is no caller identity to leak across." },
    note: "Out of scope for #53 per task instructions.",
  },
}

/**
 * Per-builder validation entry: which `CACHE_NAMESPACES` entry a `cacheKeys`
 * builder writes, its real TTL (the single source of truth call sites read
 * via `cacheTtl` below), and which argument index feeds which dimension.
 *
 * `dimensionArgIndex` only maps dimensions that correspond 1:1 to a single
 * argument — some builders take extra non-dimension qualifiers (e.g.
 * `k8sPods`'s `app`) that aren't part of the documented contract and are
 * covered by the byte-for-byte reproduction test instead.
 *
 * `cache-keys.contract.test.ts` uses this to mechanically verify, for every
 * exported builder: (1) it's declared here at all — a new builder that
 * skips this table fails a coverage test; (2) its `registryKey` resolves to
 * a real `CACHE_NAMESPACES` entry whose `dimensions` EQUAL this builder's
 * `dimensionArgIndex` key set exactly (not a subset/superset — this is why
 * the registry above is one entry per builder, see the file header); (3)
 * every sentinel value at a declared dimension's argument index actually
 * appears in the produced key; (4) varying a scope-like dimension
 * (`scope`/`user`/`role`/`cluster`) produces a different key.
 */
export interface BuilderCheck {
  registryKey: keyof typeof CACHE_NAMESPACES
  ttlSeconds: number
  args: readonly unknown[]
  dimensionArgIndex: Partial<Record<CacheDimension, number>>
}

export const BUILDER_CHECKS: Record<keyof typeof cacheKeys, BuilderCheck> = {
  myApps: { registryKey: "my-apps", ttlSeconds: 15, args: ["user-1", "fp-1"], dimensionArgIndex: { user: 0, scope: 1 } },
  routesList: { registryKey: "api:routes-list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  traces: { registryKey: "traces", ttlSeconds: 15, args: ["svc-1"], dimensionArgIndex: { query: 0 } },
  toolsHealth: { registryKey: "tools:health", ttlSeconds: 30, args: ["role-1"], dimensionArgIndex: { role: 0 } },
  architectureTopology: { registryKey: "architecture:topology", ttlSeconds: 30, args: [], dimensionArgIndex: {} },

  k8sPods: { registryKey: "k8s:pods", ttlSeconds: 10, args: ["ns-1", "app-1"], dimensionArgIndex: { namespace: 0 } },
  k8sEvents: { registryKey: "k8s:events (per-resource)", ttlSeconds: 10, args: ["ns-1", "name-1"], dimensionArgIndex: { namespace: 0, query: 1 } },
  k8sResource: { registryKey: "k8s:resource", ttlSeconds: 10, args: ["ns-1", "name-1"], dimensionArgIndex: { namespace: 0 } },
  podsList: { registryKey: "pods:list", ttlSeconds: 15, args: ["ns-1", "inst-1"], dimensionArgIndex: { namespace: 0 } },
  podsLogs: {
    registryKey: "pods:logs",
    ttlSeconds: 5,
    args: ["ns-1", "pod-1", "c-1", 200, false],
    dimensionArgIndex: { namespace: 0, query: 1 },
  },

  governanceRbacV2: { registryKey: "governance:rbac:v2", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  governanceResourcesV3: { registryKey: "governance:resources:v3", ttlSeconds: 30, args: ["fp-1"], dimensionArgIndex: { scope: 0 } },
  governanceDistributionV2: { registryKey: "governance:distribution:v2", ttlSeconds: 15, args: [], dimensionArgIndex: {} },
  governanceOperationalEventsV2: { registryKey: "governance:operational-events:v2", ttlSeconds: 15, args: [], dimensionArgIndex: {} },
  governanceOperationalEventsV3: { registryKey: "governance:operational-events:v3", ttlSeconds: 15, args: [], dimensionArgIndex: {} },
  governanceDoraV2: { registryKey: "governance:dora:v2", ttlSeconds: 120, args: ["fp-1"], dimensionArgIndex: { scope: 0 } },
  governanceScorecard: { registryKey: "governance:scorecard", ttlSeconds: 30, args: ["fp-1"], dimensionArgIndex: { scope: 0 } },

  eventsTimeline: { registryKey: "events:timeline", ttlSeconds: 15, args: ["fp-1"], dimensionArgIndex: { scope: 0 } },

  falcoEvents: { registryKey: "falco:events", ttlSeconds: 30, args: ["Critical", 60, 100], dimensionArgIndex: { query: 0 } },
  falcoCritical: { registryKey: "falco:critical", ttlSeconds: 30, args: [], dimensionArgIndex: {} },

  kisaComplianceList: { registryKey: "compliance:kisa:list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },

  heroSummary: { registryKey: "hero:summary", ttlSeconds: 10, args: [], dimensionArgIndex: {} },

  costV2: { registryKey: "cost:v2", ttlSeconds: 300, args: ["cluster", "fp-1", "price-1"], dimensionArgIndex: { query: 0, scope: 1 } },
  costServiceV2: {
    registryKey: "cost:service:v2",
    ttlSeconds: 300,
    args: ["fp-1", "ns-1", "svc-1", "price-1"],
    dimensionArgIndex: { scope: 0, query: 1 },
  },
  costTrendV2: {
    registryKey: "cost:trend:v2",
    ttlSeconds: 3600,
    args: ["cluster", "fp-1", "ns-1", "id-1", 7, "price-1"],
    dimensionArgIndex: { query: 0, scope: 1 },
  },

  apisixRoutes: { registryKey: "apisix:routes", ttlSeconds: 30, args: [], dimensionArgIndex: {} },

  promQuery: { registryKey: "prom:query", ttlSeconds: 15, args: ["primary", "up"], dimensionArgIndex: { cluster: 0, query: 1 } },
  promVector: { registryKey: "prom:vector", ttlSeconds: 15, args: ["primary", "up"], dimensionArgIndex: { cluster: 0, query: 1 } },
  promRange: { registryKey: "prom:range", ttlSeconds: 30, args: ["primary", "up", 15], dimensionArgIndex: { cluster: 0, query: 1 } },
  promNodeMetrics: { registryKey: "prom:node-metrics", ttlSeconds: 15, args: ["primary"], dimensionArgIndex: { cluster: 0 } },
  promCluster: { registryKey: "prom:cluster", ttlSeconds: 15, args: ["primary"], dimensionArgIndex: { cluster: 0 } },

  platformStatus: { registryKey: "status:platform", ttlSeconds: 15, args: [], dimensionArgIndex: {} },

  trivySummary: { registryKey: "security:summary", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  trivyWorkloads: { registryKey: "security:workloads", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  trivyImage: { registryKey: "security:image", ttlSeconds: 60, args: ["img-1"], dimensionArgIndex: { query: 0 } },
  trivyTopVulnerable: { registryKey: "security:top-vulnerable", ttlSeconds: 60, args: [10], dimensionArgIndex: { query: 0 } },

  scorecardRules: { registryKey: "scorecard:rules", ttlSeconds: 300, args: [], dimensionArgIndex: {} },
  scorecardDetail: { registryKey: "scorecard:detail", ttlSeconds: 300, args: [3, "svc-1"], dimensionArgIndex: { version: 0, query: 1 } },
  scorecardAll: { registryKey: "scorecard:all", ttlSeconds: 60, args: [3, "tier-1"], dimensionArgIndex: { version: 0, query: 1 } },

  openbaoSecrets: { registryKey: "openbao:secrets", ttlSeconds: 30, args: [], dimensionArgIndex: {} },

  alertmanagerActive: { registryKey: "alerts:active", ttlSeconds: 15, args: [], dimensionArgIndex: {} },

  complianceConfigAuditList: { registryKey: "compliance:config-audit:list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceConfigAuditDetail: {
    registryKey: "compliance:config-audit:detail",
    ttlSeconds: 60,
    args: ["ns-1", "name-1"],
    dimensionArgIndex: { query: 0 },
  },
  complianceRbacAuditList: { registryKey: "compliance:rbac-audit:list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceRbacAuditDetail: {
    registryKey: "compliance:rbac-audit:detail",
    ttlSeconds: 60,
    args: ["ns-1", "name-1"],
    dimensionArgIndex: { query: 0 },
  },
  complianceInfraAuditList: { registryKey: "compliance:infra-audit:list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceInfraAuditDetail: {
    registryKey: "compliance:infra-audit:detail",
    ttlSeconds: 60,
    args: ["node-1"],
    dimensionArgIndex: { query: 0 },
  },
  complianceFrameworksList: { registryKey: "compliance:frameworks:list", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceFrameworksDetail: {
    registryKey: "compliance:frameworks:detail",
    ttlSeconds: 60,
    args: ["id-1"],
    dimensionArgIndex: { query: 0 },
  },
  complianceSummary: { registryKey: "compliance:summary", ttlSeconds: 60, args: [], dimensionArgIndex: {} },

  // serviceGraphCluster's real TTL is computed at the call site (5s for the "1m"
  // window, 60s otherwise) — not a fixed per-namespace constant, so it's the one
  // migrated builder `cacheTtl()` deliberately does NOT cover; see the call site
  // in src/lib/service-graph.ts for the inline ternary this intentionally leaves alone.
  serviceGraphCluster: { registryKey: "graph:cluster", ttlSeconds: 60, args: ["1m", "ns-1"], dimensionArgIndex: { query: 0 } },
  serviceGraphSvc: { registryKey: "graph:svc", ttlSeconds: 60, args: ["svc-1", "1m"], dimensionArgIndex: { query: 0 } },

  k8sCniPlugin: { registryKey: "k8s:cni-plugin", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sKubeletConfig: { registryKey: "k8s:kubelet-config", ttlSeconds: 60, args: ["node-1"], dimensionArgIndex: { query: 0 } },
  k8sNamespaces: { registryKey: "k8s:namespaces", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sRbac: { registryKey: "k8s:rbac", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sEventsAll: { registryKey: "k8s:events (namespace-list)", ttlSeconds: 15, args: ["ns-1"], dimensionArgIndex: { query: 0 } },
  k8sCerts: { registryKey: "k8s:certs", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sKyverno: { registryKey: "k8s:kyverno", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sApiserverPods: { registryKey: "k8s:apiserver-pods", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sNodeReadiness: { registryKey: "k8s:node-readiness", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sControlPlaneHealth: { registryKey: "k8s:control-plane-health", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sNetpol: { registryKey: "k8s:netpol", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sNode: { registryKey: "k8s:node", ttlSeconds: 30, args: ["node-1"], dimensionArgIndex: { query: 0 } },

  healthDependencies: { registryKey: "health:dependencies", ttlSeconds: 10, args: [], dimensionArgIndex: {} },
  healthSummary: { registryKey: "health:summary", ttlSeconds: 20, args: [], dimensionArgIndex: {} },
  liveK8sInformerLease: { registryKey: "live:k8s-informer:lease", ttlSeconds: 15, args: [], dimensionArgIndex: {} },
}

/**
 * Single source of truth for a migrated builder's TTL — call sites use this
 * instead of a hand-typed literal so the number can't drift from what's
 * documented in `BUILDER_CHECKS`/`CACHE_NAMESPACES`.
 */
export function cacheTtl(name: keyof typeof cacheKeys): number {
  return BUILDER_CHECKS[name].ttlSeconds
}
