import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))
vi.mock("./argocd", () => ({
  // The READ helper swallows failure into [] (portal#54 D1); only the OrThrow
  // variant lets an aggregator tell "ArgoCD down" from "no apps".
  getArgoApps: vi.fn(async () => []),
  getArgoAppsOrThrow: vi.fn(),
}))
vi.mock("./alertmanager", () => ({
  getAlerts: vi.fn(async () => []),
  getAlertsOrThrow: vi.fn(),
}))
vi.mock("./k8s-client", () => ({
  getNodeReadiness: vi.fn(),
  getControlPlaneHealth: vi.fn(),
}))

import { cacheGet, cacheSet } from "./valkey"
import { getArgoAppsOrThrow } from "./argocd"
import { getAlertsOrThrow } from "./alertmanager"
import { getControlPlaneHealth, getNodeReadiness } from "./k8s-client"
import { getPlatformStatus } from "./platform-status"
import type { PlatformStatus } from "@/types/api"

const healthyControlPlane = [
  { name: "kube-apiserver", status: "Running" as const, restarts: 0 },
  { name: "etcd", status: "Running" as const, restarts: 0 },
]
const healthyArgoApp = {
  metadata: { name: "keycloak" },
  status: { health: { status: "Healthy" }, sync: { status: "Synced" } },
}

describe("getPlatformStatus provider failure (#53: failure is never a healthy substitute)", () => {
  beforeEach(() => {
    vi.mocked(cacheGet).mockReset().mockResolvedValue(null)
    vi.mocked(cacheSet).mockReset().mockResolvedValue(undefined as never)
    vi.mocked(getNodeReadiness).mockResolvedValue({ total: 3, ready: 3 })
    vi.mocked(getControlPlaneHealth).mockResolvedValue(healthyControlPlane)
    vi.mocked(getArgoAppsOrThrow).mockReset().mockResolvedValue([healthyArgoApp] as never)
    vi.mocked(getAlertsOrThrow).mockReset().mockResolvedValue([])
  })

  it("reports healthy only when every provider answered (baseline)", async () => {
    const status = await getPlatformStatus()
    expect(status.overall).toBe("healthy")
    expect(cacheSet).toHaveBeenCalledTimes(1)
  })

  it("does not report healthy when ArgoCD is unreachable, and does not cache that answer", async () => {
    vi.mocked(getArgoAppsOrThrow).mockRejectedValue(new Error("ArgoCD API failed: 503"))

    const status = await getPlatformStatus()

    expect(status.overall).toBe("degraded")
    expect(status.summary).toContain("argocd")
    expect(status.components.find((c) => c.id === "argocd")).toMatchObject({ status: "unknown", source: "argocd" })
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("does not report healthy when Alertmanager is unreachable, and does not cache that answer", async () => {
    vi.mocked(getAlertsOrThrow).mockRejectedValue(new Error("Alertmanager failed: 500"))

    const status = await getPlatformStatus()

    expect(status.overall).toBe("degraded")
    expect(status.summary).toContain("alertmanager")
    expect(status.incidents).toEqual([])
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it("keeps a real outage as down when a provider is also unreachable", async () => {
    vi.mocked(getControlPlaneHealth).mockResolvedValue([
      { name: "kube-apiserver", status: "Failed", restarts: 4 },
      { name: "etcd", status: "Running", restarts: 0 },
    ])
    vi.mocked(getAlertsOrThrow).mockRejectedValue(new Error("boom"))

    expect((await getPlatformStatus()).overall).toBe("down")
  })

  it("distrusts a tampered cache entry that claims healthy without the required shape", async () => {
    vi.mocked(cacheGet).mockResolvedValue({ overall: "healthy" } as never)
    vi.mocked(getAlertsOrThrow).mockRejectedValue(new Error("boom"))

    const status: PlatformStatus = await getPlatformStatus()

    expect(status.overall).toBe("degraded")
  })

  it("serves a well-formed cached entry without touching providers", async () => {
    const cached: PlatformStatus = {
      overall: "healthy",
      summary: "All systems operational",
      nodes: { total: 1, ready: 1 },
      components: [],
      incidents: [],
      generatedAt: "2026-10-15T00:00:00.000Z",
    }
    vi.mocked(cacheGet).mockResolvedValue(cached as never)

    expect(await getPlatformStatus()).toEqual(cached)
    expect(getArgoAppsOrThrow).not.toHaveBeenCalled()
  })
})

describe("getPlatformStatus single-flight (#53: no provider stampede during an outage)", () => {
  beforeEach(() => {
    vi.mocked(cacheGet).mockReset().mockResolvedValue(null)
    vi.mocked(cacheSet).mockReset().mockResolvedValue(undefined as never)
    vi.mocked(getNodeReadiness).mockReset().mockResolvedValue({ total: 3, ready: 3 })
    vi.mocked(getControlPlaneHealth).mockReset().mockResolvedValue(healthyControlPlane)
    vi.mocked(getArgoAppsOrThrow).mockReset().mockResolvedValue([healthyArgoApp] as never)
    vi.mocked(getAlertsOrThrow).mockReset().mockResolvedValue([])
  })

  it("coalesces concurrent calls into one provider fetch", async () => {
    const [a, b, c] = await Promise.all([getPlatformStatus(), getPlatformStatus(), getPlatformStatus()])

    expect(getArgoAppsOrThrow).toHaveBeenCalledTimes(1)
    expect(getAlertsOrThrow).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it("re-fetches for a call made after the in-flight one settled", async () => {
    await getPlatformStatus()
    await getPlatformStatus()

    expect(getArgoAppsOrThrow).toHaveBeenCalledTimes(2)
  })

  it("does not retain a failed aggregation", async () => {
    vi.mocked(getNodeReadiness).mockRejectedValueOnce(new Error("boom"))
    vi.mocked(getArgoAppsOrThrow).mockRejectedValueOnce(new Error("ArgoCD API failed: 503"))
    const failed = await getPlatformStatus()
    expect(failed.overall).toBe("degraded")

    const next = await getPlatformStatus()
    expect(next.overall).toBe("healthy")
    expect(getArgoAppsOrThrow).toHaveBeenCalledTimes(2)
  })
})
