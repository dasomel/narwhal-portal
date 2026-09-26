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
 * enforces for every security-sensitive namespace.
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
 *
 * Out of scope for this module (left as-is, not duplicated):
 * - `KEYCLOAK_CACHE_KEYS` / `invalidateKeycloakCaches` (src/lib/keycloak-client.ts)
 *   already centralize the `keycloak:*` / `api:groups-enriched` keys per #49.
 * - `src/lib/argocd.ts`, `src/lib/gitea.ts`, `src/lib/http-client.ts` are
 *   excluded from this slice (open PR #143 / other in-flight work); their
 *   `argocd:*` and `dora:commit:*` keys are documented in the registry below
 *   for completeness but are not built through this module.
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

export interface CacheNamespaceSpec {
  /** Example or literal key for this namespace, as it appears on the wire. */
  example: string
  /** Dimensions folded into this namespace's key. */
  dimensions: CacheDimension[]
  ttlSeconds: number | "varies"
  /** Owning module (not necessarily migrated to a builder below — see file header). */
  owner: string
  /** What mutation/event invalidates or expires this entry. */
  invalidation: string
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
   * `securitySensitive` — a hand-set flag alone made the old test
   * tautological (it only ever checked entries someone remembered to flag).
   * Entries that DO have a scope-like dimension don't need this.
   */
  unscopedReason?: string
  note?: string
}

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
} as const

/**
 * The documented contract: every cache namespace in the codebase, whether or
 * not it was migrated to a `cacheKeys` builder above. `cache-keys.contract.test.ts`
 * asserts every `securitySensitive: true` entry declares a `scope`, `user`,
 * `role`, or `cluster` dimension.
 */
export const CACHE_NAMESPACES: Record<string, CacheNamespaceSpec> = {
  "my-apps": {
    example: "my-apps:{userSub}:{scopeFingerprint}",
    dimensions: ["user", "scope"],
    ttlSeconds: 15,
    owner: "src/app/api/my-apps/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
    note: "Response is the caller's own apps/deploys/alerts — must not be served to a different user or scope.",
  },
  "api:routes-list": {
    example: "api:routes-list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/app/api/settings/routes/route.ts",
    invalidation: "cacheDel on POST (route create/update)",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "requireAdmin()-gated; identical route list for every admin.",
  },
  traces: {
    example: "traces:{service}",
    dimensions: ["query"],
    ttlSeconds: 15,
    owner: "src/app/api/traces/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Tempo trace search results, not per-caller; `service` is a query filter, not an identity.",
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
    unscopedReason: "Cluster-wide topology, same for every authenticated caller.",
  },
  "k8s:pods": {
    example: "k8s:pods:{namespace}:{app|all}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/pods/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Gate-then-serve: namespaceVisible() is checked on every request before the cache lookup, so the pod list itself never varies by caller — only whether they may read it does.",
  },
  "k8s:events (per-resource)": {
    example: "k8s:events:{namespace}:{name}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/events/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    // #145 fixed the gap this entry used to describe: namespaceVisible() is
    // now checked before the cache lookup, same as /api/k8s/pods and
    // /api/k8s/resource — so this is gate-then-serve like its siblings now.
    unscopedReason: "Gate-then-serve (portal#145): namespaceVisible() is checked on every request before the cache lookup, same as /api/k8s/pods and /api/k8s/resource.",
  },
  "k8s:resource": {
    example: "k8s:resource:{namespace}:{name}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/resource/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Gate-then-serve, same as k8s:pods.",
  },
  "pods:list": {
    example: "pods:list:{namespace}:{instance|all}",
    dimensions: ["namespace"],
    ttlSeconds: 15,
    owner: "src/app/api/pods/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Gate-then-serve (portal#33): namespaceVisible() checked before every cache lookup.",
  },
  "pods:logs": {
    example: "pods:logs:{namespace}:{pod}:{container}:{tailLines}:{previous}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 5,
    owner: "src/app/api/pods/[namespace]/[pod]/logs/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Gate-then-serve, same as pods:list.",
  },
  "governance:rbac:v2": {
    example: "governance:rbac:v2",
    dimensions: ["version"],
    ttlSeconds: 60,
    owner: "src/app/api/governance/rbac/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "requireRole('cluster-admin') gate; identical value for every cluster-admin.",
  },
  "governance:resources:v3": {
    example: "governance:resources:v3:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 30,
    owner: "src/app/api/governance/resources/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
    note: "#147: scoped per caller — non-admins reach this route too (nav gates to cluster-admin/developer/viewer, not admin-only), so the response is filtered to the caller's effective scope and the key carries scope.fingerprint.",
  },
  "governance:distribution:v2": {
    example: "governance:distribution:v2",
    dimensions: ["version"],
    ttlSeconds: 15,
    owner: "src/app/api/governance/distribution/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "auth()-gated global cluster resource view, identical for every authenticated caller.",
  },
  "governance:operational-events:v2": {
    example: "governance:operational-events:v2",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/app/api/governance/audit/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "requireRole('cluster-admin') gate; identical value for every cluster-admin.",
    note: "#144 (portal#16): renamed from governance:audit — this is an operational-events feed, not an audit trail.",
  },
  "governance:dora:v2": {
    example: "governance:dora:v2:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 120,
    owner: "src/app/api/governance/dora/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
  },
  "governance:scorecard": {
    example: "governance:scorecard:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 30,
    owner: "src/app/api/governance/scorecard/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
  },
  "events:timeline": {
    example: "events:timeline:{scopeFingerprint}",
    dimensions: ["scope"],
    ttlSeconds: 15,
    owner: "src/app/api/events/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: true,
  },
  "cluster:{id}:infra": {
    example: "cluster:{clusterId}:infra",
    dimensions: ["cluster"],
    ttlSeconds: 30,
    owner:
      "src/app/api/cluster/route.ts (writer) + src/app/(dashboard)/security/page.tsx (reader) — both via clusterCacheKey, src/lib/cluster-registry.ts",
    invalidation: "TTL only",
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
    invalidation: "TTL only",
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
    unscopedReason: "Cluster-wide runtime security events, not per-caller.",
  },
  "falco:critical": {
    example: "falco:critical",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/falco.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide runtime security events, not per-caller.",
  },
  "compliance:kisa:list": {
    example: "compliance:kisa:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/kisa.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide KISA control status, not per-caller.",
  },
  "hero:summary": {
    example: "hero:summary",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/hero.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide dashboard summary, not per-caller.",
  },
  "cost:v2": {
    example: "cost:v2:{scope}:{scopeFingerprint}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 300,
    owner: "src/lib/cost.ts",
    invalidation: "TTL only; only telemetry.state==='ok' results are cached",
    cachesPartial: false,
    securitySensitive: true,
  },
  "cost:service:v2": {
    example: "cost:service:v2:{scopeFingerprint}:{serviceNamespace}:{serviceId}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 300,
    owner: "src/lib/cost.ts",
    invalidation: "TTL only; only telemetry.state==='ok' results are cached",
    cachesPartial: false,
    securitySensitive: true,
  },
  "cost:trend:v2": {
    example: "cost:trend:v2:{scope}:{scopeFingerprint}:{serviceNamespace}:{id}:{days}:{pricingKey}",
    dimensions: ["scope", "query"],
    ttlSeconds: 3600,
    owner: "src/lib/cost.ts",
    invalidation: "TTL only; only telemetry.state==='ok' (incl. the deterministic 'empty' case) results are cached",
    cachesPartial: false,
    securitySensitive: true,
  },
  "apisix:routes": {
    example: "apisix:routes",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/apisix-client.ts",
    invalidation: "cacheDel on route mutation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "requireAdmin()-gated; identical route list for every admin.",
  },
  "prom (query/vector/range/node/cluster)": {
    example: "prom:{clusterId}:{promql}",
    dimensions: ["cluster", "query"],
    ttlSeconds: 15,
    owner: "src/lib/prometheus.ts",
    invalidation: "TTL only; provider fetch failures ('unavailable') are not cached, only genuine zero-series ('empty') results are",
    cachesPartial: false,
    securitySensitive: false,
    note: "PromQL itself already encodes any caller-scope filtering (see cost.ts's scopeNamespaceMatcher usage) at the query-string level, which is why `query` — not `scope` — is the operative dimension here.",
  },
  "status:platform": {
    example: "status:platform",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/platform-status.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide platform status, not per-caller.",
  },
  "security:*": {
    example: "security:summary | security:workloads | security:image:{image} | security:top-vulnerable:{limit}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide vulnerability data, not per-caller.",
  },
  "scorecard:*": {
    example: "scorecard:rules | scorecard:detail:{rulesVersion}:{serviceId} | scorecard:all:{rulesVersion}:{tierFilter}",
    dimensions: ["version", "query"],
    ttlSeconds: "varies",
    owner: "src/lib/scorecard.ts",
    invalidation: "TTL only; keyed by the rules ConfigMap version so a rules change is a cache-key change, not an invalidation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Rules/evaluation results are per-rules-version, not per-caller — every caller who can reach the route sees the same evaluation for the same service+rules version.",
  },
  "openbao:secrets": {
    example: "openbao:secrets",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/openbao.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Secret metadata only (paths/keys), never secret values, and not per-caller.",
  },
  "alerts:active": {
    example: "alerts:active",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/alertmanager.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide Alertmanager feed, not per-caller (per-caller filtering happens downstream in my-apps/events, which carry their own scope dimension).",
  },
  "compliance:*": {
    example: "compliance:config-audit:list | compliance:config-audit:{namespace}:{name} | compliance:rbac-audit:* | compliance:infra-audit:* | compliance:frameworks:* | compliance:summary",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide compliance audit data, not per-caller.",
  },
  "graph:*": {
    example: "graph:cluster:{window}:{namespace|all} | graph:svc:{serviceId}:{window}",
    dimensions: ["query"],
    ttlSeconds: "varies",
    owner: "src/lib/service-graph.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide service dependency graph, not per-caller.",
  },
  "k8s:* (cluster-state)": {
    example: "k8s:cni-plugin | k8s:kubelet-config:{node} | k8s:namespaces | k8s:rbac | k8s:certs | k8s:kyverno | k8s:apiserver-pods | k8s:node-readiness | k8s:control-plane-health | k8s:netpol | k8s:node:{name} | k8s:events:{namespace|all}",
    dimensions: ["query"],
    ttlSeconds: "varies",
    owner: "src/lib/k8s-client.ts",
    invalidation: "cacheDel(k8s:certs) on cert rotation; TTL only otherwise",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster infrastructure state, not per-caller; RBAC/certs/namespaces lists are cluster-admin surfaces gated at the route level.",
    note: "Cluster infrastructure state, not per-caller; RBAC/certs/namespaces lists are cluster-admin surfaces gated at the route level.",
  },
  "keycloak:* / api:groups-enriched": {
    example: "keycloak:users | keycloak:groups | keycloak:groups-detailed | api:groups-enriched",
    dimensions: [],
    ttlSeconds: "varies",
    owner: "src/lib/keycloak-client.ts (KEYCLOAK_CACHE_KEYS, already centralized per #49)",
    invalidation: "invalidateKeycloakCaches() on every membership/attribute mutation",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Admin-facing user/group directory projections, not per-caller.",
    note: "Not migrated to cacheKeys here — already owns its own centralized key/invalidation module; documented for completeness only.",
  },
  "argocd:apps / argocd:app:{name}": {
    example: "argocd:apps | argocd:app:{name}",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/argocd.ts (excluded from this slice)",
    invalidation: "cacheDel on sync",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Cluster-wide ArgoCD application state; per-caller filtering (appVisible) happens downstream at the route level, not in this cache.",
    note: "Out of scope for #53 per task instructions (src/lib/argocd.ts and its route caller are excluded — open PR #143 dependency).",
  },
  "dora:commit:{sha}": {
    example: "dora:commit:{sha}",
    dimensions: [],
    ttlSeconds: 3600,
    owner: "src/lib/gitea.ts (excluded from this slice)",
    invalidation: "TTL only (commit SHAs are immutable)",
    cachesPartial: false,
    securitySensitive: false,
    unscopedReason: "Keyed by immutable commit SHA — content-addressed, so there is no caller identity to leak across.",
    note: "Out of scope for #53 per task instructions.",
  },
}

/**
 * Per-builder validation entry: which `CACHE_NAMESPACES` family a `cacheKeys`
 * builder belongs to, its real TTL (the single source of truth call sites
 * read via `cacheTtl` below — several `CACHE_NAMESPACES` entries above are
 * documented as `"varies"` because they group multiple builders with
 * different TTLs; this table carries the exact per-builder number instead),
 * and which argument index feeds which dimension.
 *
 * `dimensionArgIndex` only maps dimensions that correspond 1:1 to a single
 * argument — some builders take extra non-dimension qualifiers (e.g.
 * `k8sPods`'s `app`) that aren't part of the documented contract and are
 * covered by the byte-for-byte reproduction test instead.
 *
 * `cache-keys.contract.test.ts` uses this to mechanically verify, for every
 * exported builder: (1) it's declared here at all — a new builder that
 * skips this table fails a coverage test; (2) every sentinel value at a
 * declared dimension's argument index actually appears in the produced key;
 * (3) varying a scope-like dimension (`scope`/`user`/`role`/`cluster`)
 * produces a different key.
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

  promQuery: { registryKey: "prom (query/vector/range/node/cluster)", ttlSeconds: 15, args: ["primary", "up"], dimensionArgIndex: { cluster: 0, query: 1 } },
  promVector: {
    registryKey: "prom (query/vector/range/node/cluster)",
    ttlSeconds: 15,
    args: ["primary", "up"],
    dimensionArgIndex: { cluster: 0, query: 1 },
  },
  promRange: {
    registryKey: "prom (query/vector/range/node/cluster)",
    ttlSeconds: 30,
    args: ["primary", "up", 15],
    dimensionArgIndex: { cluster: 0, query: 1 },
  },
  promNodeMetrics: { registryKey: "prom (query/vector/range/node/cluster)", ttlSeconds: 15, args: ["primary"], dimensionArgIndex: { cluster: 0 } },
  promCluster: { registryKey: "prom (query/vector/range/node/cluster)", ttlSeconds: 15, args: ["primary"], dimensionArgIndex: { cluster: 0 } },

  platformStatus: { registryKey: "status:platform", ttlSeconds: 15, args: [], dimensionArgIndex: {} },

  trivySummary: { registryKey: "security:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  trivyWorkloads: { registryKey: "security:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  trivyImage: { registryKey: "security:*", ttlSeconds: 60, args: ["img-1"], dimensionArgIndex: { query: 0 } },
  trivyTopVulnerable: { registryKey: "security:*", ttlSeconds: 60, args: [10], dimensionArgIndex: { query: 0 } },

  scorecardRules: { registryKey: "scorecard:*", ttlSeconds: 300, args: [], dimensionArgIndex: {} },
  scorecardDetail: { registryKey: "scorecard:*", ttlSeconds: 300, args: [3, "svc-1"], dimensionArgIndex: { version: 0, query: 1 } },
  scorecardAll: { registryKey: "scorecard:*", ttlSeconds: 60, args: [3, "tier-1"], dimensionArgIndex: { version: 0, query: 1 } },

  openbaoSecrets: { registryKey: "openbao:secrets", ttlSeconds: 30, args: [], dimensionArgIndex: {} },

  alertmanagerActive: { registryKey: "alerts:active", ttlSeconds: 15, args: [], dimensionArgIndex: {} },

  complianceConfigAuditList: { registryKey: "compliance:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceConfigAuditDetail: { registryKey: "compliance:*", ttlSeconds: 60, args: ["ns-1", "name-1"], dimensionArgIndex: { query: 0 } },
  complianceRbacAuditList: { registryKey: "compliance:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceRbacAuditDetail: { registryKey: "compliance:*", ttlSeconds: 60, args: ["ns-1", "name-1"], dimensionArgIndex: { query: 0 } },
  complianceInfraAuditList: { registryKey: "compliance:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceInfraAuditDetail: { registryKey: "compliance:*", ttlSeconds: 60, args: ["node-1"], dimensionArgIndex: { query: 0 } },
  complianceFrameworksList: { registryKey: "compliance:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  complianceFrameworksDetail: { registryKey: "compliance:*", ttlSeconds: 60, args: ["id-1"], dimensionArgIndex: { query: 0 } },
  complianceSummary: { registryKey: "compliance:*", ttlSeconds: 60, args: [], dimensionArgIndex: {} },

  // serviceGraphCluster's real TTL is computed at the call site (5s for the "1m"
  // window, 60s otherwise) — not a fixed per-namespace constant, so it's the one
  // migrated builder `cacheTtl()` deliberately does NOT cover; see the call site
  // in src/lib/service-graph.ts for the inline ternary this intentionally leaves alone.
  serviceGraphCluster: { registryKey: "graph:*", ttlSeconds: 60, args: ["1m", "ns-1"], dimensionArgIndex: { query: 0 } },
  serviceGraphSvc: { registryKey: "graph:*", ttlSeconds: 60, args: ["svc-1", "1m"], dimensionArgIndex: { query: 0 } },

  k8sCniPlugin: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sKubeletConfig: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 60, args: ["node-1"], dimensionArgIndex: { query: 0 } },
  k8sNamespaces: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sRbac: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sEventsAll: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 15, args: ["ns-1"], dimensionArgIndex: { query: 0 } },
  k8sCerts: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sKyverno: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sApiserverPods: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 60, args: [], dimensionArgIndex: {} },
  k8sNodeReadiness: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sControlPlaneHealth: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sNetpol: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: [], dimensionArgIndex: {} },
  k8sNode: { registryKey: "k8s:* (cluster-state)", ttlSeconds: 30, args: ["node-1"], dimensionArgIndex: { query: 0 } },
}

/**
 * Single source of truth for a migrated builder's TTL — call sites use this
 * instead of a hand-typed literal so the number can't drift from what's
 * documented in `BUILDER_CHECKS`/`CACHE_NAMESPACES`.
 */
export function cacheTtl(name: keyof typeof cacheKeys): number {
  return BUILDER_CHECKS[name].ttlSeconds
}
