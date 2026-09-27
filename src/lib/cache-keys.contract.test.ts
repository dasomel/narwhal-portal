import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BUILDER_CHECKS, CACHE_NAMESPACES, cacheKeys, cacheTtl, type CacheDimension, type CacheInvalidationEvent } from "./cache-keys"
import { clusterCacheKey } from "./cluster-registry"
import { invalidationPatternsFor } from "./cache-invalidation"

const SCOPE_LIKE_DIMENSIONS: CacheDimension[] = ["scope", "user", "role", "cluster"]

// Repo root — this file lives at src/lib/, so ownerPath (repo-relative) resolves two levels up.
const REPO_ROOT = path.resolve(__dirname, "../..")

function readOwnerFile(ownerPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ownerPath), "utf8")
}

/** Invoke a `cacheKeys` builder with arbitrary sentinel args (heterogeneous arities/types across builders — `any` is the point here, not an oversight). */
function invoke(name: keyof typeof cacheKeys, args: readonly unknown[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (cacheKeys[name] as (...a: any[]) => string)(...args)
}

/** A sentinel distinct from `value`, preserving its type so it still fits the builder's parameter. */
function altSentinel(value: unknown): unknown {
  if (typeof value === "string") return `${value}-ALT`
  if (typeof value === "number") return value + 1
  if (typeof value === "boolean") return !value
  return value
}

describe("cache-keys contract (#53)", () => {
  it("every registered namespace declares its dimensions and TTL", () => {
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      expect(Array.isArray(spec.dimensions), `${name} must declare a dimensions array`).toBe(true)
      expect(spec.ttlSeconds !== undefined, `${name} must declare a TTL`).toBe(true)
      expect(typeof spec.invalidation, `${name} must document its invalidation trigger`).toBe("string")
      expect(spec.invalidation.length > 0, `${name} invalidation note must not be empty`).toBe(true)
    }
  })

  it("every registered invalidation trigger has a namespace mapping and purge pattern", () => {
    const mappings = new Map<string, string[]>()
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      for (const trigger of spec.invalidationTriggers ?? []) {
        const patterns = spec.invalidationPatterns ?? []
        expect(patterns.length, `${name} registers ${trigger} without purge patterns`).toBeGreaterThan(0)
        mappings.set(trigger, [...(mappings.get(trigger) ?? []), ...patterns])
      }
    }
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      for (const trigger of spec.invalidationTriggers ?? []) {
        expect(mappings.get(trigger), `${name}'s ${trigger} trigger has no mapping`).toBeDefined()
      }
    }
    for (const [trigger, patterns] of mappings) {
      expect(invalidationPatternsFor(trigger as CacheInvalidationEvent), `${trigger} helper mapping differs from registry`)
        .toEqual([...new Set(patterns)])
    }
  })

  it("high-frequency event types are never mapped to glob invalidation patterns", () => {
    const highFrequencyEvents: CacheInvalidationEvent[] = ["event.ingested"]
    for (const event of highFrequencyEvents) {
      expect(invalidationPatternsFor(event).filter((pattern) => pattern.includes("*") || pattern.includes("?") || pattern.includes("[")), event)
        .toEqual([])
    }
  })

  // AC: "all security-sensitive/domain caches have documented scope dimensions" —
  // a namespace whose cached VALUE differs by caller identity/team/cluster must
  // fold that into the key via `scope`, `user`, `role`, or `cluster`. This check
  // is deliberately NOT gated on `securitySensitive` (that flag is hand-set and
  // made an earlier version of this test tautological — it only ever checked
  // entries someone remembered to flag). Instead it applies to EVERY entry: a
  // namespace with no scope-like dimension must justify that with a non-empty
  // `unscopedReason`, so a new caller-scoped cache that forgets both the
  // dimension AND the flag still fails here.
  it("every namespace declares a scope-like dimension or an explicit unscopedReason", () => {
    const offenders: string[] = []
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      const hasScopeDimension = spec.dimensions.some((d) => SCOPE_LIKE_DIMENSIONS.includes(d))
      // `unscopedReason.code` is a closed union (UnscopedReasonCode) — the type
      // checker already rejects an arbitrary string here, so this is a runtime
      // belt-and-suspenders check against a cast/`as any` bypassing that.
      const hasReason = typeof spec.unscopedReason?.code === "string" && spec.unscopedReason.code.length > 0
      if (!hasScopeDimension && !hasReason) offenders.push(name)
    }
    expect(offenders, `namespaces with no scope-like dimension and no unscopedReason: ${offenders.join(", ")}`).toEqual([])
  })

  // Cheap, mechanical spot-check on two of the six UnscopedReasonCode values:
  // "admin-only-route" and "gate-then-serve" both make a falsifiable claim
  // about the owning route's source — that it calls a specific guard function
  // — so we grep for it instead of trusting the label. The other four codes
  // (cluster-wide-state / downstream-filtered / content-addressed /
  // owned-elsewhere) don't reduce to a single grep-able guard, so they're not
  // cheaply checkable here and are intentionally left to code review.
  it("admin-only-route namespaces' owner file actually calls an admin/role guard", () => {
    const offenders: string[] = []
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      if (spec.unscopedReason?.code !== "admin-only-route") continue
      if (!spec.ownerPath) {
        offenders.push(`${name}: admin-only-route but no ownerPath set for verification`)
        continue
      }
      const src = readOwnerFile(spec.ownerPath)
      if (!/requireAdmin\(|requireRole\(/.test(src)) {
        offenders.push(`${name}: ownerPath ${spec.ownerPath} has no requireAdmin(/requireRole( call`)
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  it("gate-then-serve namespaces' owner file actually calls namespaceVisible", () => {
    const offenders: string[] = []
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      if (spec.unscopedReason?.code !== "gate-then-serve") continue
      if (!spec.ownerPath) {
        offenders.push(`${name}: gate-then-serve but no ownerPath set for verification`)
        continue
      }
      const src = readOwnerFile(spec.ownerPath)
      if (!src.includes("namespaceVisible(")) {
        offenders.push(`${name}: ownerPath ${spec.ownerPath} has no namespaceVisible( call`)
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  // Same AC, from the builder side: `securitySensitive: true` is still a useful
  // human-facing flag, but it must agree with the dimensions actually declared —
  // flip it on without a real scope-like dimension and this catches it too.
  it("every securitySensitive:true namespace's dimensions actually justify the flag", () => {
    const offenders: string[] = []
    for (const [name, spec] of Object.entries(CACHE_NAMESPACES)) {
      if (!spec.securitySensitive) continue
      const hasScopeDimension = spec.dimensions.some((d) => SCOPE_LIKE_DIMENSIONS.includes(d))
      if (!hasScopeDimension) offenders.push(name)
    }
    expect(offenders, `securitySensitive:true but no scope-like dimension: ${offenders.join(", ")}`).toEqual([])
  })

  // AC: "a new builder can't bypass the registry" — every exported cacheKeys
  // builder must have a BUILDER_CHECKS entry, and that entry's registryKey must
  // resolve to a real CACHE_NAMESPACES entry.
  it("every exported cacheKeys builder is covered by BUILDER_CHECKS and maps to a real registry entry", () => {
    const builderNames = Object.keys(cacheKeys) as Array<keyof typeof cacheKeys>
    const checkedNames = Object.keys(BUILDER_CHECKS)
    const uncovered = builderNames.filter((n) => !checkedNames.includes(n))
    expect(uncovered, `cacheKeys builders missing a BUILDER_CHECKS entry: ${uncovered.join(", ")}`).toEqual([])

    const danglingRegistryRefs = Object.entries(BUILDER_CHECKS)
      .filter(([, check]) => !(check.registryKey in CACHE_NAMESPACES))
      .map(([name, check]) => `${name} -> ${check.registryKey}`)
    expect(danglingRegistryRefs, `BUILDER_CHECKS entries pointing at a nonexistent registry key: ${danglingRegistryRefs.join(", ")}`).toEqual([])
  })

  // AC (tightened after review): a builder's declared dimensions and its
  // registry entry's declared dimensions are two independent, hand-written
  // lists — nothing before this test compared them, so both could say the
  // wrong (but matching-looking) thing at once, e.g. BUILDER_CHECKS missing a
  // dimension the registry documents, or vice versa. This asserts SET
  // EQUALITY between `BUILDER_CHECKS[name].dimensionArgIndex`'s keys and
  // `CACHE_NAMESPACES[registryKey].dimensions` for every builder — not a
  // subset either direction. This is also why the registry is one entry per
  // builder (see the file header): a shared aggregate entry's dimension list
  // is the union across builders with different arities, which can never
  // equal any single builder's own set.
  it("every builder's dimensionArgIndex keys equal its registry entry's dimensions exactly", () => {
    const offenders: string[] = []
    for (const [name, check] of Object.entries(BUILDER_CHECKS) as Array<[keyof typeof cacheKeys, (typeof BUILDER_CHECKS)[keyof typeof cacheKeys]]>) {
      const builderDims = new Set(Object.keys(check.dimensionArgIndex))
      const registryDims = new Set(CACHE_NAMESPACES[check.registryKey].dimensions)
      const missingFromRegistry = [...builderDims].filter((d) => !registryDims.has(d as CacheDimension))
      const missingFromBuilder = [...registryDims].filter((d) => !builderDims.has(d))
      if (missingFromRegistry.length > 0 || missingFromBuilder.length > 0) {
        offenders.push(
          `${name} (-> ${check.registryKey}): builder has [${[...builderDims].join(",")}], registry has [${[...registryDims].join(",")}]` +
            (missingFromRegistry.length ? ` — builder-only: ${missingFromRegistry.join(",")}` : "") +
            (missingFromBuilder.length ? ` — registry-only: ${missingFromBuilder.join(",")}` : "")
        )
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  // AC: "call the builder with sentinel values per declared dimension and assert
  // every sentinel appears in the key (and that two different scope values
  // produce different keys)". This is the mechanical link between a builder's
  // ACTUAL output and what BUILDER_CHECKS claims it depends on — a builder that
  // silently drops an argument, or a dimension mapped to the wrong index, fails
  // here even though the byte-for-byte test above only checks fixed examples.
  it("every declared dimension's sentinel appears in the builder's output", () => {
    const offenders: string[] = []
    for (const [name, check] of Object.entries(BUILDER_CHECKS) as Array<[keyof typeof cacheKeys, (typeof BUILDER_CHECKS)[keyof typeof cacheKeys]]>) {
      const key = invoke(name, check.args)
      for (const [dim, index] of Object.entries(check.dimensionArgIndex)) {
        const sentinel = String(check.args[index as number])
        if (!key.includes(sentinel)) offenders.push(`${name}.${dim}@${index}: sentinel "${sentinel}" missing from "${key}"`)
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  it("varying a scope-like dimension's argument changes the builder's output", () => {
    const offenders: string[] = []
    for (const [name, check] of Object.entries(BUILDER_CHECKS) as Array<[keyof typeof cacheKeys, (typeof BUILDER_CHECKS)[keyof typeof cacheKeys]]>) {
      const baseKey = invoke(name, check.args)
      for (const [dim, index] of Object.entries(check.dimensionArgIndex)) {
        if (!SCOPE_LIKE_DIMENSIONS.includes(dim as CacheDimension)) continue
        const variedArgs = check.args.slice()
        variedArgs[index as number] = altSentinel(check.args[index as number])
        const variedKey = invoke(name, variedArgs)
        if (variedKey === baseKey) offenders.push(`${name}.${dim}@${index}: varying it did not change the key ("${baseKey}")`)
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  it("cacheTtl resolves every migrated builder's TTL from BUILDER_CHECKS (single source of truth)", () => {
    for (const name of Object.keys(cacheKeys) as Array<keyof typeof cacheKeys>) {
      expect(cacheTtl(name)).toBe(BUILDER_CHECKS[name].ttlSeconds)
      expect(typeof cacheTtl(name)).toBe("number")
    }
  })

  it("no namespace caches a partial/failed provider response by default", () => {
    const offenders = Object.entries(CACHE_NAMESPACES)
      .filter(([, spec]) => spec.cachesPartial)
      .map(([name]) => name)
    expect(offenders, `namespaces caching partial/failed responses: ${offenders.join(", ")}`).toEqual([])
  })
})

// Cross-user/team/cluster cache leakage: for every migrated security-sensitive
// builder, two different callers (different user/scope/cluster) must resolve to
// two different keys, so one caller's cached response can never be served to
// the other.
describe("cross-user/team/cluster cache leakage", () => {
  it("my-apps keys differ per user and per scope", () => {
    expect(cacheKeys.myApps("user-a", "fp-1")).not.toBe(cacheKeys.myApps("user-b", "fp-1"))
    expect(cacheKeys.myApps("user-a", "fp-1")).not.toBe(cacheKeys.myApps("user-a", "fp-2"))
  })

  it("governance:dora:v2 keys differ per scope fingerprint", () => {
    expect(cacheKeys.governanceDoraV2("fp-team-a")).not.toBe(cacheKeys.governanceDoraV2("fp-team-b"))
  })

  // #147: /api/governance/resources became scope-filtered (non-admins reach it
  // too), so its cache key must carry scope.fingerprint the same way.
  it("governance:resources:v3 keys differ per scope fingerprint", () => {
    expect(cacheKeys.governanceResourcesV3("fp-team-a")).not.toBe(cacheKeys.governanceResourcesV3("fp-team-b"))
  })

  it("governance:scorecard keys differ per scope fingerprint", () => {
    expect(cacheKeys.governanceScorecard("fp-team-a")).not.toBe(cacheKeys.governanceScorecard("fp-team-b"))
  })

  it("events:timeline keys differ per scope fingerprint", () => {
    expect(cacheKeys.eventsTimeline("fp-team-a")).not.toBe(cacheKeys.eventsTimeline("fp-team-b"))
  })

  it("cost:v2 / cost:service:v2 / cost:trend:v2 keys differ per scope fingerprint", () => {
    expect(cacheKeys.costV2("cluster", "fp-a", "price-1")).not.toBe(cacheKeys.costV2("cluster", "fp-b", "price-1"))
    expect(cacheKeys.costServiceV2("fp-a", "ns", "svc", "price-1")).not.toBe(cacheKeys.costServiceV2("fp-b", "ns", "svc", "price-1"))
    expect(cacheKeys.costTrendV2("cluster", "fp-a", undefined, "id", 7, "price-1")).not.toBe(
      cacheKeys.costTrendV2("cluster", "fp-b", undefined, "id", 7, "price-1")
    )
  })

  it("tools:health keys differ per role", () => {
    expect(cacheKeys.toolsHealth("admin")).not.toBe(cacheKeys.toolsHealth("viewer"))
  })

  it("cluster-scoped keys (clusterCacheKey) differ per cluster_id — portal#21/#133 isolation", () => {
    expect(clusterCacheKey("primary", "infra")).not.toBe(clusterCacheKey("secondary", "infra"))
    expect(clusterCacheKey("primary", "domain")).not.toBe(clusterCacheKey("secondary", "domain"))
  })
})

describe("cacheKeys builders reproduce the pre-existing key strings byte-for-byte", () => {
  it("matches every literal template this module replaced", () => {
    expect(cacheKeys.myApps("u1", "fp1")).toBe("my-apps:u1:fp1")
    expect(cacheKeys.routesList()).toBe("api:routes-list")
    expect(cacheKeys.traces("svc")).toBe("traces:svc")
    expect(cacheKeys.traces("")).toBe("traces:")
    expect(cacheKeys.podsLogs("ns", "pod", "", 200, false)).toBe("pods:logs:ns:pod::200:false")
    expect(cacheKeys.toolsHealth("admin")).toBe("tools:health:admin")
    expect(cacheKeys.architectureTopology()).toBe("architecture:topology")
    expect(cacheKeys.k8sPods("ns", "app")).toBe("k8s:pods:ns:app")
    expect(cacheKeys.k8sPods("ns", undefined)).toBe("k8s:pods:ns:all")
    expect(cacheKeys.k8sEvents("ns", "name")).toBe("k8s:events:ns:name")
    expect(cacheKeys.k8sResource("ns", "name")).toBe("k8s:resource:ns:name")
    expect(cacheKeys.podsList("ns", "inst")).toBe("pods:list:ns:inst")
    expect(cacheKeys.podsList("ns", undefined)).toBe("pods:list:ns:all")
    expect(cacheKeys.podsLogs("ns", "pod", "c1", 200, false)).toBe("pods:logs:ns:pod:c1:200:false")
    expect(cacheKeys.governanceRbacV2()).toBe("governance:rbac:v2")
    expect(cacheKeys.governanceResourcesV3("fp")).toBe("governance:resources:v3:fp")
    expect(cacheKeys.governanceDistributionV2()).toBe("governance:distribution:v2")
    expect(cacheKeys.governanceOperationalEventsV2()).toBe("governance:operational-events:v2")
    expect(cacheKeys.governanceDoraV2("fp")).toBe("governance:dora:v2:fp")
    expect(cacheKeys.governanceScorecard("fp")).toBe("governance:scorecard:fp")
    expect(cacheKeys.eventsTimeline("fp")).toBe("events:timeline:fp")
    expect(cacheKeys.falcoEvents("Critical", 60, 100)).toBe("falco:events:Critical:60:100")
    expect(cacheKeys.falcoEvents(undefined, 60, 100)).toBe("falco:events:all:60:100")
    expect(cacheKeys.falcoCritical()).toBe("falco:critical")
    expect(cacheKeys.kisaComplianceList()).toBe("compliance:kisa:list")
    expect(cacheKeys.heroSummary()).toBe("hero:summary")
    expect(cacheKeys.costV2("cluster", "fp", "price")).toBe("cost:v2:cluster:fp:price")
    expect(cacheKeys.costServiceV2("fp", "ns", "svc", "price")).toBe("cost:service:v2:fp:ns:svc:price")
    expect(cacheKeys.costTrendV2("namespace", "fp", "ns", "id", 7, "price")).toBe("cost:trend:v2:namespace:fp:ns:id:7:price")
    expect(cacheKeys.costTrendV2("cluster", "fp", undefined, "id", 7, "price")).toBe("cost:trend:v2:cluster:fp::id:7:price")
    expect(cacheKeys.apisixRoutes()).toBe("apisix:routes")
    expect(cacheKeys.promQuery("primary", "up")).toBe("prom:primary:up")
    expect(cacheKeys.promVector("primary", "up")).toBe("promv:primary:up")
    expect(cacheKeys.promRange("primary", "up", 15)).toBe("promr:primary:up:15")
    expect(cacheKeys.promNodeMetrics("primary")).toBe("promnodemetrics:primary")
    expect(cacheKeys.promCluster("primary")).toBe("promcluster:primary")
    expect(cacheKeys.platformStatus()).toBe("status:platform")
    expect(cacheKeys.trivySummary()).toBe("security:summary")
    expect(cacheKeys.trivyWorkloads()).toBe("security:workloads")
    expect(cacheKeys.trivyImage("nginx:latest")).toBe("security:image:nginx:latest")
    expect(cacheKeys.trivyTopVulnerable(10)).toBe("security:top-vulnerable:10")
    expect(cacheKeys.scorecardRules()).toBe("scorecard:rules")
    expect(cacheKeys.scorecardDetail(3, "svc")).toBe("scorecard:detail:3:svc")
    expect(cacheKeys.scorecardAll(3, "gold")).toBe("scorecard:all:3:gold")
    expect(cacheKeys.scorecardAll(3, undefined)).toBe("scorecard:all:3:")
    expect(cacheKeys.openbaoSecrets()).toBe("openbao:secrets")
    expect(cacheKeys.alertmanagerActive()).toBe("alerts:active")
    expect(cacheKeys.complianceConfigAuditList()).toBe("compliance:config-audit:list")
    expect(cacheKeys.complianceConfigAuditDetail("ns", "name")).toBe("compliance:config-audit:ns:name")
    expect(cacheKeys.complianceRbacAuditList()).toBe("compliance:rbac-audit:list")
    expect(cacheKeys.complianceRbacAuditDetail("ns", "name")).toBe("compliance:rbac-audit:ns:name")
    expect(cacheKeys.complianceInfraAuditList()).toBe("compliance:infra-audit:list")
    expect(cacheKeys.complianceInfraAuditDetail("node1")).toBe("compliance:infra-audit:node1")
    expect(cacheKeys.complianceFrameworksList()).toBe("compliance:frameworks:list")
    expect(cacheKeys.complianceFrameworksDetail("id1")).toBe("compliance:frameworks:id1")
    expect(cacheKeys.complianceSummary()).toBe("compliance:summary")
    expect(cacheKeys.serviceGraphCluster("1m", "ns")).toBe("graph:cluster:1m:ns")
    expect(cacheKeys.serviceGraphCluster("1m", undefined)).toBe("graph:cluster:1m:all")
    expect(cacheKeys.serviceGraphSvc("svc", "1m")).toBe("graph:svc:svc:1m")
    expect(cacheKeys.k8sCniPlugin()).toBe("k8s:cni-plugin")
    expect(cacheKeys.k8sKubeletConfig("node1")).toBe("k8s:kubelet-config:node1")
    expect(cacheKeys.k8sNamespaces()).toBe("k8s:namespaces")
    expect(cacheKeys.k8sRbac()).toBe("k8s:rbac")
    expect(cacheKeys.k8sEventsAll("ns")).toBe("k8s:events:ns")
    expect(cacheKeys.k8sEventsAll(undefined)).toBe("k8s:events:all")
    expect(cacheKeys.k8sCerts()).toBe("k8s:certs")
    expect(cacheKeys.k8sKyverno()).toBe("k8s:kyverno")
    expect(cacheKeys.k8sApiserverPods()).toBe("k8s:apiserver-pods")
    expect(cacheKeys.k8sNodeReadiness()).toBe("k8s:node-readiness")
    expect(cacheKeys.k8sControlPlaneHealth()).toBe("k8s:control-plane-health")
    expect(cacheKeys.k8sNetpol()).toBe("k8s:netpol")
    expect(cacheKeys.k8sNode("node1")).toBe("k8s:node:node1")
  })
})
