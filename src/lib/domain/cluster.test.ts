import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  deriveCapabilityState,
  projectClusterDomain,
  probeClusterHealth,
  CLUSTER_DOMAIN_SCHEMA_VERSION,
  type ClusterProbeResult,
} from "./cluster"
import {
  FIXTURE_CLUSTER_REACHABLE,
  FIXTURE_PROBE_REACHABLE,
  FIXTURE_CLUSTER_UNREACHABLE,
  FIXTURE_PROBE_UNREACHABLE,
} from "./cluster.fixtures"

describe("deriveCapabilityState — capability-discovery semantics matrix", () => {
  it("not-applicable always wins, even on an unreachable cluster", () => {
    expect(deriveCapabilityState("not-applicable", { reachable: false, authenticated: false })).toEqual({
      status: "not-applicable",
      source: "registry",
    })
  })

  it("not-applicable wins even when reachable+authenticated", () => {
    expect(deriveCapabilityState("not-applicable", { reachable: true, authenticated: true })).toEqual({
      status: "not-applicable",
      source: "registry",
    })
  })

  it("unreachable cluster degrades a declared 'supported' capability to unavailable", () => {
    const result = deriveCapabilityState("supported", { reachable: false, authenticated: false })
    expect(result.status).toBe("unavailable")
    expect(result.source).toBe("live-probe")
  })

  it("reachable but unauthenticated degrades a declared 'supported' capability to partial", () => {
    const result = deriveCapabilityState("supported", { reachable: true, authenticated: false })
    expect(result.status).toBe("partial")
    expect(result.source).toBe("live-probe")
  })

  it("reachable + authenticated passes the declared 'supported' value through unchanged", () => {
    expect(deriveCapabilityState("supported", { reachable: true, authenticated: true })).toEqual({
      status: "supported",
      source: "registry",
    })
  })

  it("reachable + authenticated passes the declared 'partial' value through unchanged (not upgraded to supported)", () => {
    expect(deriveCapabilityState("partial", { reachable: true, authenticated: true })).toEqual({
      status: "partial",
      source: "registry",
    })
  })

  it("reachable + authenticated passes the declared 'unavailable' value through unchanged (probe doesn't override a known-broken declaration)", () => {
    expect(deriveCapabilityState("unavailable", { reachable: true, authenticated: true })).toEqual({
      status: "unavailable",
      source: "registry",
    })
  })
})

describe("projectClusterDomain — pure projection, fixture-driven", () => {
  it("projects a reachable cluster as healthy with declared capabilities passed through", () => {
    const domain = projectClusterDomain(FIXTURE_CLUSTER_REACHABLE, FIXTURE_PROBE_REACHABLE, {
      now: new Date("2026-08-25T01:00:00.000Z"),
    })

    expect(domain.schemaVersion).toBe(CLUSTER_DOMAIN_SCHEMA_VERSION)
    expect(domain.id).toBe("fixture-reachable")
    expect(domain.health).toBe("healthy")
    expect(domain.capabilities.argocd).toEqual({ status: "supported", source: "registry" })
    expect(domain.capabilities.storage).toEqual({ status: "partial", source: "registry" })
    expect(domain.resource).toEqual({ cluster: "fixture-reachable" })
    expect(domain.freshness).toEqual({
      asOf: "2026-08-25T01:00:00.000Z",
      source: "live-probe",
      cacheAgeSeconds: null,
    })
    // No raw K8s field names leak into the domain shape.
    expect(domain).not.toHaveProperty("metadata")
    expect(domain).not.toHaveProperty("status.conditions")
  })

  it("projects the destroyed/unreachable cluster as offline with every applicable capability unavailable, and preserves its declared not-applicable", () => {
    const domain = projectClusterDomain(FIXTURE_CLUSTER_UNREACHABLE, FIXTURE_PROBE_UNREACHABLE, {
      now: new Date("2026-08-25T01:00:00.000Z"),
    })

    expect(domain.health).toBe("offline")
    expect(domain.capabilities.argocd.status).toBe("unavailable")
    expect(domain.capabilities.metrics.status).toBe("unavailable")
    expect(domain.capabilities.storage.status).toBe("unavailable")
    // logs was declared not-applicable on this fixture cluster while it was
    // still alive — that declaration must survive projection unchanged even
    // though the cluster itself is now unreachable.
    expect(domain.capabilities.logs).toEqual({ status: "not-applicable", source: "registry" })
  })

  it("treats a null probe (credentials not configured) identically to an unreachable probe", () => {
    const domain = projectClusterDomain(FIXTURE_CLUSTER_UNREACHABLE, null, {
      now: new Date("2026-08-25T01:00:00.000Z"),
    })
    expect(domain.health).toBe("offline")
    expect(domain.capabilities.argocd.status).toBe("unavailable")
    expect(domain.freshness.source).toBe("fixture")
  })

  it("honors an explicit freshnessSource/cacheAgeSeconds override for a cache-hit re-serve", () => {
    const domain = projectClusterDomain(FIXTURE_CLUSTER_REACHABLE, FIXTURE_PROBE_REACHABLE, {
      now: new Date("2026-08-25T01:00:30.000Z"),
      freshnessSource: "cache",
      cacheAgeSeconds: 12,
    })
    expect(domain.freshness).toEqual({
      asOf: "2026-08-25T01:00:30.000Z",
      source: "cache",
      cacheAgeSeconds: 12,
    })
  })
})

describe("probeClusterHealth — impure adapter, never throws", () => {
  it("degrades to unreachable rather than throwing when nothing is listening", async () => {
    // Port 1 is a reserved/privileged port with nothing bound to it in test
    // environments — connection is refused immediately, no need to wait out
    // the timeout. This is the same failure mode as probing the destroyed
    // Kakao Cloud cluster's old API server endpoint.
    const result = await probeClusterHealth("http://127.0.0.1:1", "unused-token", 500)
    expect(result.reachable).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(result.versionKnown).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("reports authenticated:false on a 401 without throwing", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ message: "unauthorized" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const result: ClusterProbeResult = await probeClusterHealth(`http://127.0.0.1:${port}`, "bad-token", 1000)
      expect(result.reachable).toBe(true)
      expect(result.authenticated).toBe(false)
      expect(result.versionKnown).toBe(false)
    } finally {
      server.close()
    }
  })

  it("reports reachable+authenticated+versionKnown on a healthy /version response", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ gitVersion: "v1.32.0" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const result = await probeClusterHealth(`http://127.0.0.1:${port}`, "good-token", 1000)
      expect(result).toEqual({
        reachable: true,
        authenticated: true,
        versionKnown: true,
        probedAt: result.probedAt,
        error: null,
      })
    } finally {
      server.close()
    }
  })
})
