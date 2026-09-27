import { describe, it, expect, vi, afterEach } from "vitest"
import type { DependencyHealthSnapshot } from "@/lib/dependency-health"

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue({ session: { user: { role: "cluster-admin" } } }),
}))

const mockGetSnapshot = vi.fn()

vi.mock("@/lib/dependency-health", () => ({
  getDependencyHealthSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
}))

import { GET } from "./route"
import { requireRole } from "@/lib/auth"

function okSnapshot(): DependencyHealthSnapshot {
  return {
    observedAt: "2026-09-27T00:00:00.000Z",
    dependencies: [
      { dependency: "prometheus", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
      { dependency: "kubernetes", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
      { dependency: "argocd", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
      { dependency: "gitea", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
      { dependency: "keycloak", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
      { dependency: "valkey", state: "ok", observedAt: "2026-09-27T00:00:00.000Z" },
    ],
  }
}

describe("GET /api/health/dependencies (portal#47)", () => {
  afterEach(() => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin" } } } as never)
    mockGetSnapshot.mockReset()
  })

  it("rejects an unauthenticated caller with 401 and does not build a snapshot", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ error: "unauthorized" } as never)

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(401)
    expect(json).toEqual({ error: "Unauthorized" })
    expect(mockGetSnapshot).not.toHaveBeenCalled()
  })

  it.each(["developer", "viewer", "guest"])(
    "rejects a %s session with 403 — this endpoint is cluster-admin-only like /api/health/status",
    async (role) => {
      vi.mocked(requireRole).mockResolvedValueOnce({ error: "forbidden" } as never)

      const res = await GET()
      const json = await res.json()

      expect(res.status).toBe(403)
      expect(json).toEqual({ error: "Forbidden" })
      expect(mockGetSnapshot).not.toHaveBeenCalled()
      void role // role only documents which non-admin case this is; the gate mock is uniform
    }
  )

  it("requires the cluster-admin role specifically, not a broader authenticated set", async () => {
    mockGetSnapshot.mockResolvedValue(okSnapshot())

    await GET()

    expect(requireRole).toHaveBeenCalledWith("cluster-admin")
  })

  it("returns the snapshot body as-is for a cluster-admin caller", async () => {
    const snapshot = okSnapshot()
    mockGetSnapshot.mockResolvedValue(snapshot)

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual(snapshot)
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)
  })

  it("passes through a degraded snapshot (unavailable/unauthorized dependencies) unchanged", async () => {
    const snapshot: DependencyHealthSnapshot = {
      observedAt: "2026-09-27T00:00:00.000Z",
      dependencies: [
        { dependency: "argocd", state: "unavailable", observedAt: "2026-09-27T00:00:00.000Z", reason: "timeout" },
        { dependency: "keycloak", state: "unauthorized", observedAt: "2026-09-27T00:00:00.000Z", reason: "http_401" },
      ],
    }
    mockGetSnapshot.mockResolvedValue(snapshot)

    const res = await GET()
    const json = await res.json()

    expect(json).toEqual(snapshot)
  })

  it("re-probes a degraded snapshot on each admin request", async () => {
    mockGetSnapshot.mockResolvedValue({
      observedAt: "2026-09-27T00:00:00.000Z",
      dependencies: [{ dependency: "kubernetes", state: "unavailable", observedAt: "2026-09-27T00:00:00.000Z" }],
    })

    await GET()
    await GET()

    expect(mockGetSnapshot).toHaveBeenCalledTimes(2)
  })
})
