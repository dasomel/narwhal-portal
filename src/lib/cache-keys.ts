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
    note: "Cluster-admin-gated global APISIX route list; identical for every caller with access.",
  },
  traces: {
    example: "traces:{service}",
    dimensions: ["query"],
    ttlSeconds: 15,
    owner: "src/app/api/traces/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
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
    note: "Cluster-wide topology, same for every authenticated caller.",
  },
  "k8s:pods": {
    example: "k8s:pods:{namespace}:{app|all}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/pods/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Gate-then-serve: namespaceVisible() is checked on every request before the cache lookup, so the pod list itself never varies by caller — only whether they may read it does.",
  },
  "k8s:events (per-resource)": {
    example: "k8s:events:{namespace}:{name}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/events/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "#145 fixed the gap this note used to describe: namespaceVisible() is now checked before the cache lookup, same as /api/k8s/pods and /api/k8s/resource.",
  },
  "k8s:resource": {
    example: "k8s:resource:{namespace}:{name}",
    dimensions: ["namespace"],
    ttlSeconds: 10,
    owner: "src/app/api/k8s/resource/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Gate-then-serve, same as k8s:pods.",
  },
  "pods:list": {
    example: "pods:list:{namespace}:{instance|all}",
    dimensions: ["namespace"],
    ttlSeconds: 15,
    owner: "src/app/api/pods/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Gate-then-serve (portal#33): namespaceVisible() checked before every cache lookup.",
  },
  "pods:logs": {
    example: "pods:logs:{namespace}:{pod}:{container}:{tailLines}:{previous}",
    dimensions: ["namespace", "query"],
    ttlSeconds: 5,
    owner: "src/app/api/pods/[namespace]/[pod]/logs/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Gate-then-serve, same as pods:list.",
  },
  "governance:rbac:v2": {
    example: "governance:rbac:v2",
    dimensions: ["version"],
    ttlSeconds: 60,
    owner: "src/app/api/governance/rbac/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "requireRole('cluster-admin') gate; identical value for every cluster-admin.",
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
  },
  "governance:operational-events:v2": {
    example: "governance:operational-events:v2",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/app/api/governance/audit/route.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "#144 (portal#16): renamed from governance:audit — this is an operational-events feed, not an audit trail; requireRole('cluster-admin') gate.",
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
  },
  "falco:critical": {
    example: "falco:critical",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/falco.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "compliance:kisa:list": {
    example: "compliance:kisa:list",
    dimensions: [],
    ttlSeconds: 60,
    owner: "src/lib/kisa.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "hero:summary": {
    example: "hero:summary",
    dimensions: [],
    ttlSeconds: 10,
    owner: "src/lib/hero.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
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
  },
  "security:*": {
    example: "security:summary | security:workloads | security:image:{image} | security:top-vulnerable:{limit}",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/trivy.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Cluster-wide vulnerability data, not per-caller.",
  },
  "scorecard:*": {
    example: "scorecard:rules | scorecard:detail:{rulesVersion}:{serviceId} | scorecard:all:{rulesVersion}:{tierFilter}",
    dimensions: ["version", "query"],
    ttlSeconds: "varies",
    owner: "src/lib/scorecard.ts",
    invalidation: "TTL only; keyed by the rules ConfigMap version so a rules change is a cache-key change, not an invalidation",
    cachesPartial: false,
    securitySensitive: false,
  },
  "openbao:secrets": {
    example: "openbao:secrets",
    dimensions: [],
    ttlSeconds: 30,
    owner: "src/lib/openbao.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
    note: "Secret metadata only (paths/keys), never secret values.",
  },
  "alerts:active": {
    example: "alerts:active",
    dimensions: [],
    ttlSeconds: 15,
    owner: "src/lib/alertmanager.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "compliance:*": {
    example: "compliance:config-audit:list | compliance:config-audit:{namespace}:{name} | compliance:rbac-audit:* | compliance:infra-audit:* | compliance:frameworks:* | compliance:summary",
    dimensions: ["query"],
    ttlSeconds: 60,
    owner: "src/lib/compliance.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "graph:*": {
    example: "graph:cluster:{window}:{namespace|all} | graph:svc:{serviceId}:{window}",
    dimensions: ["query"],
    ttlSeconds: "varies",
    owner: "src/lib/service-graph.ts",
    invalidation: "TTL only",
    cachesPartial: false,
    securitySensitive: false,
  },
  "k8s:* (cluster-state)": {
    example: "k8s:cni-plugin | k8s:kubelet-config:{node} | k8s:namespaces | k8s:rbac | k8s:certs | k8s:kyverno | k8s:apiserver-pods | k8s:node-readiness | k8s:control-plane-health | k8s:netpol | k8s:node:{name} | k8s:events:{namespace|all}",
    dimensions: ["query"],
    ttlSeconds: "varies",
    owner: "src/lib/k8s-client.ts",
    invalidation: "cacheDel(k8s:certs) on cert rotation; TTL only otherwise",
    cachesPartial: false,
    securitySensitive: false,
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
    note: "Out of scope for #53 per task instructions.",
  },
}
