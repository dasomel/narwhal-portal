import { describe, it, expect, vi, afterEach } from "vitest"
import type { DependencyStatus } from "@/lib/dependency-health"

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue({ session: { user: { role: "cluster-admin" } } }),
}))

const mockProbeHttp = vi.fn()
const mockProbeK8s = vi.fn()
const mockProbeValkey = vi.fn()

vi.mock("@/lib/dependency-health", () => ({
  probeHttpDependency: (...args: unknown[]) => mockProbeHttp(...args),
  probeK8sDependency: (...args: unknown[]) => mockProbeK8s(...args),
  probeValkeyDependency: (...args: unknown[]) => mockProbeValkey(...args),
}))

import { GET } from "./route"
import { requireRole } from "@/lib/auth"

function httpStatus(dependency: DependencyStatus["dependency"], overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return { dependency, state: "ok", observedAt: "2026-09-27T00:00:00.000Z", ...overrides }
}

function resetProbesToOk() {
  mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
    Promise.resolve(httpStatus(dependency))
  )
  mockProbeK8s.mockResolvedValue(httpStatus("kubernetes"))
  mockProbeValkey.mockResolvedValue(httpStatus("valkey"))
}

describe("GET /api/health/dependencies (portal#47)", () => {
  afterEach(() => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin" } } } as never)
    mockProbeHttp.mockReset()
    mockProbeK8s.mockReset()
    mockProbeValkey.mockReset()
  })

  it("rejects an unauthenticated caller with 401 and does not probe any dependency", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ error: "unauthorized" } as never)

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(401)
    expect(json).toEqual({ error: "Unauthorized" })
    expect(mockProbeHttp).not.toHaveBeenCalled()
    expect(mockProbeK8s).not.toHaveBeenCalled()
    expect(mockProbeValkey).not.toHaveBeenCalled()
  })

  it("rejects a session with no matching role with 403", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ error: "forbidden" } as never)

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json).toEqual({ error: "Forbidden" })
    expect(mockProbeHttp).not.toHaveBeenCalled()
  })

  it("aggregates all six dependency probes for an authenticated caller", async () => {
    resetProbesToOk()

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.observedAt).toBeDefined()
    const names = json.dependencies.map((d: DependencyStatus) => d.dependency)
    expect(names.sort()).toEqual(["argocd", "gitea", "keycloak", "kubernetes", "prometheus", "valkey"].sort())
    expect(mockProbeHttp).toHaveBeenCalledTimes(4) // prometheus, argocd, gitea, keycloak
  })

  it("passes through an unavailable probe result unchanged", async () => {
    resetProbesToOk()
    mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
      Promise.resolve(
        dependency === "argocd"
          ? httpStatus("argocd", { state: "unavailable", reason: "timeout" })
          : httpStatus(dependency)
      )
    )

    const res = await GET()
    const json = await res.json()
    const argocd = json.dependencies.find((d: DependencyStatus) => d.dependency === "argocd")

    expect(argocd).toMatchObject({ state: "unavailable", reason: "timeout" })
  })

  it("passes through an unauthorized probe result unchanged", async () => {
    resetProbesToOk()
    mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
      Promise.resolve(
        dependency === "keycloak"
          ? httpStatus("keycloak", { state: "unauthorized", reason: "http_401" })
          : httpStatus(dependency)
      )
    )

    const res = await GET()
    const json = await res.json()
    const keycloak = json.dependencies.find((d: DependencyStatus) => d.dependency === "keycloak")

    expect(keycloak).toMatchObject({ state: "unauthorized", reason: "http_401" })
  })

  it("passes through a stale probe result unchanged", async () => {
    resetProbesToOk()
    mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
      Promise.resolve(dependency === "gitea" ? httpStatus("gitea", { state: "stale" }) : httpStatus(dependency))
    )

    const res = await GET()
    const json = await res.json()
    const gitea = json.dependencies.find((d: DependencyStatus) => d.dependency === "gitea")

    expect(gitea).toMatchObject({ state: "stale" })
  })

  it("keeps the redacted detail field for a cluster-admin caller", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ session: { user: { role: "cluster-admin" } } } as never)
    resetProbesToOk()
    mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
      Promise.resolve(
        dependency === "argocd"
          ? httpStatus("argocd", {
              state: "unavailable",
              reason: "network",
              detail: "Network error calling https://argocd.narwhal.internal/api/v1/session",
            })
          : httpStatus(dependency)
      )
    )

    const res = await GET()
    const json = await res.json()
    const argocd = json.dependencies.find((d: DependencyStatus) => d.dependency === "argocd")

    expect(argocd.detail).toContain("argocd.narwhal.internal")
  })

  it("strips the detail field (and any hostname it carries) for a non-admin caller", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ session: { user: { role: "viewer" } } } as never)
    resetProbesToOk()
    mockProbeHttp.mockImplementation((dependency: DependencyStatus["dependency"]) =>
      Promise.resolve(
        dependency === "argocd"
          ? httpStatus("argocd", {
              state: "unavailable",
              reason: "network",
              detail: "Network error calling https://argocd.narwhal.internal/api/v1/session",
            })
          : httpStatus(dependency)
      )
    )

    const res = await GET()
    const json = await res.json()

    expect(json.dependencies.find((d: DependencyStatus) => d.dependency === "argocd").detail).toBeUndefined()
    const text = JSON.stringify(json)
    expect(text).not.toContain("argocd.narwhal.internal")
    expect(text).not.toContain("http://")
    expect(text).not.toContain("https://")
  })

  it("re-probes every dependency on each call instead of caching a prior result", async () => {
    resetProbesToOk()

    await GET()
    await GET()

    expect(mockProbeK8s).toHaveBeenCalledTimes(2)
    expect(mockProbeValkey).toHaveBeenCalledTimes(2)
    expect(mockProbeHttp.mock.calls.length).toBeGreaterThanOrEqual(8) // 4 http deps x 2 calls
  })
})
