/**
 * Domain API — Cluster/Fleet — portal#46 pilot.
 *
 * Serves the domain-shaped projection (src/lib/domain/cluster.ts) instead of
 * a raw K8s-API-shaped response. This is deliberately a NEW route rather
 * than a retrofit of GET /api/cluster: that route's `ClusterInfra` shape
 * (nodes/controlPlane/namespaces with K8s field names) is a real consumer
 * (the infra-detail dashboard) this pass isn't touching, and portal#46's own
 * acceptance criteria frame the domain contract as additive ("Core Portal
 * pages CAN consume domain objects", not "must replace every existing
 * route"). A future pass can retrofit dashboard widgets to read from here.
 *
 * `?fixture=true` serves the two offline/replay fixtures
 * (src/lib/domain/cluster.fixtures.ts) directly — no registry, no cache, no
 * network — satisfying the issue's "Portal can be developed/tested without
 * every OSS control plane being live" requirement as something you can
 * actually hit over HTTP, not just something covered in unit tests.
 */
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { auth } from "@/lib/auth"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { listClusters, getCluster, resolveClusterCredentials, clusterCacheKey } from "@/lib/cluster-registry"
import {
  projectClusterDomain,
  probeClusterHealth,
  CLUSTER_DOMAIN_SCHEMA_VERSION,
  type ClusterDomainObject,
  type ClusterDomainSchemaVersion,
} from "@/lib/domain/cluster"
import {
  FIXTURE_CLUSTER_REACHABLE,
  FIXTURE_PROBE_REACHABLE,
  FIXTURE_CLUSTER_UNREACHABLE,
  FIXTURE_PROBE_UNREACHABLE,
} from "@/lib/domain/cluster.fixtures"
import type { Cluster } from "@/types/cluster"

export const dynamic = "force-dynamic"

export interface ClusterDomainListResponse {
  schemaVersion: ClusterDomainSchemaVersion
  generatedAt: string
  /** Echoes an inbound X-Correlation-Id, or mints a fresh one — same convention as beginOperation (src/lib/operation-context.ts) for a read path that doesn't emit a lifecycle event. */
  correlationId: string
  clusters: ClusterDomainObject[]
}

const DOMAIN_CACHE_TTL_SECONDS = 30
const PROBE_TIMEOUT_MS = 2000

interface CachedDomainEntry {
  domain: ClusterDomainObject
  cachedAt: string
}

function readCorrelationId(request: NextRequest): string {
  const inbound = request.headers.get("x-correlation-id")
  return inbound && inbound.trim().length > 0 ? inbound.trim() : randomUUID()
}

async function resolveDomainForCluster(cluster: Cluster, now: Date): Promise<ClusterDomainObject> {
  const cacheKey = clusterCacheKey(cluster.id, "domain")
  const cached = await cacheGet<CachedDomainEntry>(cacheKey)
  if (cached) {
    const cacheAgeSeconds = Math.max(0, Math.round((now.getTime() - new Date(cached.cachedAt).getTime()) / 1000))
    return {
      ...cached.domain,
      freshness: { asOf: cached.cachedAt, source: "cache", cacheAgeSeconds },
    }
  }

  const credentials = resolveClusterCredentials(cluster)
  const probe = credentials ? await probeClusterHealth(credentials.apiServer, credentials.token, PROBE_TIMEOUT_MS) : null
  const domain = projectClusterDomain(cluster, probe, { now })

  // Cache failure is non-fatal (repo-wide convention — src/lib/valkey.ts
  // swallows its own errors), so no try/catch needed here.
  await cacheSet(cacheKey, { domain, cachedAt: now.toISOString() } satisfies CachedDomainEntry, DOMAIN_CACHE_TTL_SECONDS)
  return domain
}

function fixtureResponse(correlationId: string, now: Date): ClusterDomainListResponse {
  return {
    schemaVersion: CLUSTER_DOMAIN_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    correlationId,
    clusters: [
      projectClusterDomain(FIXTURE_CLUSTER_REACHABLE, FIXTURE_PROBE_REACHABLE, { now, freshnessSource: "fixture" }),
      projectClusterDomain(FIXTURE_CLUSTER_UNREACHABLE, FIXTURE_PROBE_UNREACHABLE, { now, freshnessSource: "fixture" }),
    ],
  }
}

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const now = new Date()
  const correlationId = readCorrelationId(request)

  if (request.nextUrl.searchParams.get("fixture") === "true") {
    return NextResponse.json(fixtureResponse(correlationId, now))
  }

  const clusterId = request.nextUrl.searchParams.get("cluster_id")

  try {
    let clusters: Cluster[]
    if (clusterId) {
      const one = await getCluster(clusterId)
      if (!one) {
        return NextResponse.json(
          { error: "ValidationError", message: `cluster '${clusterId}' is not registered`, field: "cluster_id" },
          { status: 400 },
        )
      }
      clusters = [one]
    } else {
      clusters = await listClusters()
    }

    const domainClusters = await Promise.all(clusters.map((c) => resolveDomainForCluster(c, now)))

    const body: ClusterDomainListResponse = {
      schemaVersion: CLUSTER_DOMAIN_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      correlationId,
      clusters: domainClusters,
    }
    return NextResponse.json(body)
  } catch (err) {
    console.error("[api/domain/clusters]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
