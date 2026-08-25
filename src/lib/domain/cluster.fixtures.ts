/**
 * Offline/replay fixtures for the Cluster/Fleet domain projection — portal#46.
 *
 * The issue explicitly asks for "offline/replay fixtures so the Portal can be
 * developed/tested without every OSS control plane being live." This is not
 * hypothetical for this session: the one real cluster this portal has ever
 * talked to (Kakao Cloud, portal#21's `primary`) was destroyed 2026-08-10
 * (see the `kakao-cloud-cluster-live` memory note) and has not been
 * recreated. These two fixtures stand in for "a cluster that IS reachable"
 * and "a cluster that ISN'T" — used directly by cluster.test.ts, and
 * servable from GET /api/domain/clusters?fixture=true for manual/dev use
 * with no live cluster required at all.
 *
 * Both fixture Cluster records use credentialRef env var names that are
 * never actually read (probes below use canned ClusterProbeResult values,
 * not resolveClusterCredentials + a real fetch) — see the file header note
 * on FIXTURE_* naming.
 */
import type { Cluster } from "@/types/cluster"
import type { ClusterProbeResult } from "./cluster"

const FIXTURE_TIMESTAMP = "2026-08-25T00:00:00.000Z"

export const FIXTURE_CLUSTER_REACHABLE: Cluster = {
  id: "fixture-reachable",
  name: "Fixture — Reachable Cluster",
  environment: "sandbox",
  provider: "on-prem",
  region: null,
  endpointHint: "fixture:6443",
  credentialRef: { apiServerEnvVar: "FIXTURE_REACHABLE_API_UNUSED", tokenEnvVar: "FIXTURE_REACHABLE_TOKEN_UNUSED" },
  capabilities: {
    argocd: "supported",
    metrics: "supported",
    events: "supported",
    storage: "partial",
    rbac: "supported",
    logs: "supported",
  },
  status: "unknown",
  registeredAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
}

export const FIXTURE_PROBE_REACHABLE: ClusterProbeResult = {
  reachable: true,
  authenticated: true,
  versionKnown: true,
  probedAt: FIXTURE_TIMESTAMP,
  error: null,
}

/**
 * Modeled directly on this session's actual state: the Kakao Cloud cluster
 * was destroyed 2026-08-10 (52/52 resources torn down per the
 * `kakao-cloud-cluster-live` memory note); `provision-kakao.sh` would
 * recreate it, but nothing has re-run it. A probe against its old API
 * server endpoint today would fail exactly like FIXTURE_PROBE_UNREACHABLE.
 */
export const FIXTURE_CLUSTER_UNREACHABLE: Cluster = {
  id: "fixture-unreachable",
  name: "Fixture — Unreachable Cluster (destroyed)",
  environment: "production",
  provider: "kakao-cloud",
  region: "kr-central-2",
  endpointHint: "VIP :6443 (destroyed 2026-08-10)",
  credentialRef: { apiServerEnvVar: "FIXTURE_UNREACHABLE_API_UNUSED", tokenEnvVar: "FIXTURE_UNREACHABLE_TOKEN_UNUSED" },
  capabilities: {
    argocd: "supported",
    metrics: "supported",
    events: "supported",
    storage: "supported",
    rbac: "supported",
    // Falco/logs pipeline was never wired for this fixture cluster in life — a
    // real "not-applicable" case that must survive the projection unchanged
    // even though the cluster is now unreachable (see deriveCapabilityState).
    logs: "not-applicable",
  },
  status: "unknown",
  registeredAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
}

export const FIXTURE_PROBE_UNREACHABLE: ClusterProbeResult = {
  reachable: false,
  authenticated: false,
  versionKnown: false,
  probedAt: FIXTURE_TIMESTAMP,
  error: "ECONNREFUSED (fixture: cluster destroyed 2026-08-10)",
}
