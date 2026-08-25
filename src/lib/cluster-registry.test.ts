import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import {
  validateClusterRegistration,
  canRemoveCluster,
  deriveClusterHealth,
  clusterCacheKey,
  resolveClusterCredentials,
} from "./cluster-registry"
import type { Cluster, ClusterRegistrationInput } from "@/types/cluster"
import { ValidationError } from "./validation"

function fakeCluster(overrides: Partial<Cluster> = {}): Cluster {
  return {
    id: "primary",
    name: "Narwhal (Kakao Cloud)",
    environment: "production",
    provider: "kakao-cloud",
    region: "kr-central-2",
    endpointHint: null,
    credentialRef: { apiServerEnvVar: "K8S_API_SERVER", tokenEnvVar: "K8S_SA_TOKEN" },
    capabilities: { argocd: "supported", metrics: "supported", events: "supported", storage: "supported", rbac: "supported", logs: "supported" },
    status: "unknown",
    registeredAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  }
}

function registrationInput(overrides: Partial<ClusterRegistrationInput> = {}): ClusterRegistrationInput {
  return {
    id: "secondary",
    name: "Second Cluster",
    environment: "staging",
    provider: "on-prem",
    credentialRef: { apiServerEnvVar: "K8S_API_SERVER_SECONDARY", tokenEnvVar: "K8S_SA_TOKEN_SECONDARY" },
    ...overrides,
  }
}

describe("validateClusterRegistration", () => {
  it("accepts a well-formed registration against an empty registry", () => {
    const cluster = validateClusterRegistration(registrationInput(), [])
    expect(cluster.id).toBe("secondary")
    expect(cluster.status).toBe("unknown")
    expect(cluster.capabilities.argocd).toBe("unavailable") // default profile fills unset capabilities
  })

  it("rejects a duplicate id — this is the 'register at least 2 independent clusters' guarantee", () => {
    const existing = [fakeCluster()]
    expect(() => validateClusterRegistration(registrationInput({ id: "primary" }), existing)).toThrow(ValidationError)
  })

  it("allows a second cluster with a distinct id and distinct credential env vars", () => {
    const existing = [fakeCluster()]
    const second = validateClusterRegistration(registrationInput(), existing)
    expect(second.id).not.toBe(existing[0].id)
    expect(second.credentialRef.apiServerEnvVar).not.toBe(existing[0].credentialRef.apiServerEnvVar)
  })

  it("rejects a credential env var reused from another cluster — the cross-cluster leak this issue flags", () => {
    const existing = [fakeCluster()]
    expect(() =>
      validateClusterRegistration(
        registrationInput({ credentialRef: { apiServerEnvVar: "K8S_API_SERVER", tokenEnvVar: "OTHER_TOKEN" } }),
        existing,
      ),
    ).toThrow(/already used by cluster 'primary'/)
  })

  it("rejects an invalid id format", () => {
    expect(() => validateClusterRegistration(registrationInput({ id: "Not_Valid!" }), [])).toThrow(ValidationError)
  })

  it("rejects an unknown environment", () => {
    // @ts-expect-error deliberately invalid input, as an API caller could send
    expect(() => validateClusterRegistration(registrationInput({ environment: "prod" }), [])).toThrow(ValidationError)
  })

  it("rejects an unknown provider", () => {
    // @ts-expect-error deliberately invalid input, as an API caller could send
    expect(() => validateClusterRegistration(registrationInput({ provider: "digitalocean" }), [])).toThrow(ValidationError)
  })

  it("rejects a missing credentialRef", () => {
    expect(() => validateClusterRegistration(registrationInput({ credentialRef: undefined }), [])).toThrow(ValidationError)
  })

  it("rejects an invalid capability status", () => {
    // @ts-expect-error deliberately invalid input, as an API caller could send
    expect(() => validateClusterRegistration(registrationInput({ capabilities: { argocd: "yes" } }), [])).toThrow(ValidationError)
  })
})

describe("canRemoveCluster", () => {
  it("refuses to remove the last remaining cluster", () => {
    const verdict = canRemoveCluster("primary", [fakeCluster()])
    expect(verdict.ok).toBe(false)
  })

  it("allows removing one of several clusters", () => {
    const verdict = canRemoveCluster("primary", [fakeCluster(), fakeCluster({ id: "secondary" })])
    expect(verdict.ok).toBe(true)
  })

  it("refuses to remove an id that isn't registered", () => {
    const verdict = canRemoveCluster("nope", [fakeCluster(), fakeCluster({ id: "secondary" })])
    expect(verdict.ok).toBe(false)
  })
})

describe("deriveClusterHealth — exhaustive, never false-green", () => {
  it("unreachable -> offline, regardless of other checks", () => {
    expect(deriveClusterHealth({ reachable: false, authenticated: true, versionKnown: true })).toBe("offline")
  })
  it("reachable but not authenticated -> degraded, not healthy", () => {
    expect(deriveClusterHealth({ reachable: true, authenticated: false, versionKnown: true })).toBe("degraded")
  })
  it("reachable and authenticated but version unknown -> degraded", () => {
    expect(deriveClusterHealth({ reachable: true, authenticated: true, versionKnown: false })).toBe("degraded")
  })
  it("all checks pass -> healthy", () => {
    expect(deriveClusterHealth({ reachable: true, authenticated: true, versionKnown: true })).toBe("healthy")
  })
})

describe("clusterCacheKey", () => {
  it("namespaces the key under the cluster id, matching the issue's cluster:{id}:... spec", () => {
    expect(clusterCacheKey("primary", "infra")).toBe("cluster:primary:infra")
  })
  it("two clusters never produce the same key for the same resource — no cross-cluster cache leakage", () => {
    expect(clusterCacheKey("primary", "infra")).not.toBe(clusterCacheKey("secondary", "infra"))
  })
  it("rejects a cluster id outside the safe charset rather than interpolating it", () => {
    expect(() => clusterCacheKey("a:b", "infra")).toThrow(ValidationError)
  })
})

describe("resolveClusterCredentials", () => {
  const cluster = fakeCluster({ credentialRef: { apiServerEnvVar: "TEST_CLUSTER_API", tokenEnvVar: "TEST_CLUSTER_TOKEN" } })

  beforeEach(() => {
    vi.stubEnv("TEST_CLUSTER_API", "")
    vi.stubEnv("TEST_CLUSTER_TOKEN", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("returns null when the referenced apiServer env var is unset — not a thrown error", () => {
    expect(resolveClusterCredentials(cluster)).toBeNull()
  })

  it("resolves apiServer + token from the referenced env vars when set", () => {
    vi.stubEnv("TEST_CLUSTER_API", "https://cluster-2.example:6443")
    vi.stubEnv("TEST_CLUSTER_TOKEN", "s3cr3t")
    expect(resolveClusterCredentials(cluster)).toEqual({ apiServer: "https://cluster-2.example:6443", token: "s3cr3t" })
  })

  it("defaults token to empty string when only apiServer is configured", () => {
    vi.stubEnv("TEST_CLUSTER_API", "https://cluster-2.example:6443")
    expect(resolveClusterCredentials(cluster)).toEqual({ apiServer: "https://cluster-2.example:6443", token: "" })
  })
})
