import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  aggregateDependencyHealth,
  getDependencyHealthSummary,
  probeHttpDependency,
  probeK8sDependency,
  probeValkeyDependency,
  type DependencyName,
  type DependencyStatus,
} from "./dependency-health"
import { costTelemetryToDependencyStatus } from "./cost"

const { ping, requireRole, getSnapshot } = vi.hoisted(() => ({
  ping: vi.fn(),
  requireRole: vi.fn(),
  getSnapshot: vi.fn(),
}))
vi.mock("./valkey", () => ({
  getValkey: () => ({ ping }),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
}))
vi.mock("@/lib/auth", () => ({ requireRole }))
vi.mock("./dependency-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependency-health")>()
  return { ...actual, getDependencyHealthSnapshot: getSnapshot }
})
vi.mock("@/lib/live-k8s-informer", () => ({ getLiveK8sInformerStatus: () => ({ detail: "informer detail" }) }))
vi.mock("@/lib/live-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/live-stream")>()
  return { ...actual, getLiveStreamMetrics: () => ({ detail: "stream detail" }) }
})

import { GET as getSummaryRoute } from "@/app/api/health/summary/route"
import { GET as getDependenciesRoute } from "@/app/api/health/dependencies/route"

// Valkey has no HTTP status/body or credential response; stale currently has a real producer only in telemetry.
const MATRIX: Record<DependencyName, readonly string[]> = {
  prometheus: ["timeout", "5xx", "connection-refused", "body-not-inspected", "stale-cache", "credential"],
  kubernetes: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  argocd: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  gitea: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  keycloak: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  valkey: ["timeout", "connection-refused"],
  openbao: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  alertmanager: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
  loki: ["timeout", "5xx", "connection-refused", "body-not-inspected", "credential"],
}
const providers = Object.keys(MATRIX) as DependencyName[]

function readCoreProviders(): DependencyName[] {
  const source = readFileSync(new URL("./dependency-health.ts", import.meta.url), "utf8")
  const declaration = source.match(/const CORE_DEPENDENCIES:[^=]*= new Set\(([\s\S]*?)\n\]\)/)?.[1]
  if (!declaration) throw new Error("Could not read CORE_DEPENDENCIES")
  return [...declaration.matchAll(/"([a-z]+)"/g)].map((match) => match[1]) as DependencyName[]
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  ping.mockReset()
  requireRole.mockReset()
  getSnapshot.mockReset()
})

describe("dependency provider failure matrix", () => {
  it("lists every provider in the exported dependency contract", () => {
    const source = readFileSync(new URL("./dependency-health.ts", import.meta.url), "utf8")
    const union = source.match(/export type DependencyName\s*=([\s\S]*?)\n\n/)?.[1]
    if (!union) throw new Error("Could not read exported DependencyName union")
    const contractProviders = [...union.matchAll(/"([a-z]+)"/g)].map((match) => match[1]).sort()
    expect(providers.slice().sort()).toEqual(contractProviders)
    expect(contractProviders.length).toBeGreaterThan(0)
  })

  it.each(providers.flatMap((provider) => MATRIX[provider].map((failure) => [provider, failure] as const)))(
    "%s maps %s to its expected status, reason, and redacted aggregate",
    async (provider, failure) => {
      let status: DependencyStatus
      if (failure === "stale-cache") {
        status = costTelemetryToDependencyStatus({
          source: "prometheus", queriedAt: "2026-09-28T12:00:00.000Z", state: "stale", reason: "cache_stale",
        })
      } else if (provider === "valkey") {
        vi.stubEnv("VALKEY_URL", "redis://valkey.test:6379")
        ping.mockReset().mockRejectedValue(new Error(failure))
        status = await probeValkeyDependency()
      } else {
        const url = `https://${provider}.example.test/health`
        const statusCode = failure === "credential" ? 401 : failure === "5xx" ? 503 : 200
        vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
          if (failure === "connection-refused") return Promise.reject(new TypeError("fetch failed"))
          if (failure === "timeout") {
            return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
          }
          return Promise.resolve({ ok: statusCode === 200, status: statusCode, body: null })
        }))
        if (provider === "kubernetes") {
          if (failure === "timeout") vi.useFakeTimers()
          const probe = probeK8sDependency({ timeoutMs: 10 })
          if (failure === "timeout") {
            await vi.advanceTimersByTimeAsync(10)
          }
          status = await probe
        } else if (failure === "timeout") {
          vi.useFakeTimers()
          const probe = probeHttpDependency(provider, url, { timeoutMs: 10 })
          await vi.advanceTimersByTimeAsync(10)
          status = await probe
        } else {
          status = await probeHttpDependency(provider, url, { timeoutMs: 10 })
        }
      }

      const expectedState = failure === "body-not-inspected" ? "ok"
        : failure === "credential" ? "unauthorized"
          : failure === "5xx" ? (provider === "kubernetes" ? "unavailable" : "partial")
            : failure === "stale-cache" ? "stale" : "unavailable"
      expect(status.state).toBe(expectedState)
      const expectedReason = failure === "body-not-inspected" ? undefined
        : failure === "credential" ? "http_401"
          : failure === "5xx" ? "http_503"
            : failure === "timeout" ? "timeout"
              : failure === "connection-refused" ? "network"
                : failure === "stale-cache" ? "cache_stale" : "timeout_or_network"
      expect(status.reason).toBe(provider === "valkey" ? "timeout_or_network" : expectedReason)
      if (failure === "body-not-inspected") expect(status).not.toHaveProperty("reason")

      const statuses: DependencyStatus[] = providers.map((name) => name === provider
        ? status
        : { dependency: name, state: "ok", observedAt: "2026-09-28T12:00:00.000Z" })
      const aggregate = aggregateDependencyHealth(statuses)
      const isCore = readCoreProviders().includes(provider)
      const expectedAggregate = expectedState === "ok" ? "ok"
        : isCore && (expectedState === "unavailable" || expectedState === "unauthorized") ? "unavailable"
          : "degraded"
      expect(aggregate.state).toBe(expectedAggregate)
      expect(Object.keys(aggregate).sort()).toEqual(["observedAt", "state"])
      expect(JSON.stringify(aggregate)).not.toMatch(/prometheus|kubernetes|argocd|gitea|keycloak|valkey|openbao|alertmanager|loki|\.example\.test/)
    },
  )

  it("keeps details out of summary function and routes for non-admin callers", async () => {
    vi.stubEnv("PROMETHEUS_URL", "https://prometheus.example.test/health")
    vi.stubEnv("ARGOCD_URL", "https://argocd.example.test/health")
    vi.stubEnv("GITEA_URL", "https://gitea.example.test/health")
    vi.stubEnv("KEYCLOAK_ISSUER", "https://keycloak.example.test/health")
    vi.stubEnv("VALKEY_URL", "redis://valkey.test:6379")
    ping.mockResolvedValue("PONG")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }))
    const summary = await getDependencyHealthSummary()
    expect(summary).toEqual({ state: "ok", observedAt: expect.any(String) })
    expect(JSON.stringify(summary)).not.toMatch(/dependency|host|url|detail|example\.test/i)

    requireRole.mockResolvedValue({ session: { user: { role: "viewer" } } })
    const summaryResponse = await getSummaryRoute()
    const summaryText = await summaryResponse.text()
    expect(summaryResponse.status).toBe(200)
    expect(summaryText).not.toMatch(/kubernetes|prometheus|argocd|host|url|detail|example\.test/i)
    requireRole.mockResolvedValueOnce({ session: { user: { role: "cluster-admin" } } })
    const adminSummaryResponse = await getSummaryRoute()
    expect(adminSummaryResponse.status).toBe(200)
    expect(await adminSummaryResponse.text()).not.toMatch(/kubernetes|prometheus|argocd|host|url|detail|example\.test/i)

    requireRole.mockResolvedValueOnce({ error: "forbidden" })
    const dependenciesResponse = await getDependenciesRoute()
    expect(dependenciesResponse.status).toBe(403)
    expect(await dependenciesResponse.text()).not.toMatch(/kubernetes|host|url|detail|example\.test/i)
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it("returns dependency names and diagnostics only to cluster-admin on dependencies route", async () => {
    requireRole.mockResolvedValue({ session: { user: { role: "cluster-admin" } } })
    getSnapshot.mockResolvedValue({
      observedAt: "2026-09-28T12:00:00.000Z",
      dependencies: [{ dependency: "prometheus", state: "unavailable", observedAt: "2026-09-28T12:00:00.000Z", reason: "timeout", detail: "https://prometheus.example.test/health" }],
    })
    const response = await getDependenciesRoute()
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toMatch(/prometheus|example\.test|timeout|detail/)
  })
})
