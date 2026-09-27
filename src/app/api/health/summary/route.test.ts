import { afterEach, describe, expect, it, vi } from "vitest"
import type { AggregateDependencyHealth } from "@/lib/dependency-health"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/dependency-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dependency-health")>()
  return { ...actual, getDependencyHealthSummary: vi.fn() }
})

import { requireRole } from "@/lib/auth"
import { getDependencyHealthSummary } from "@/lib/dependency-health"
import { GET } from "./route"

const observedAt = "2026-09-28T00:00:00.000Z"

function summary(state: AggregateDependencyHealth["state"]): AggregateDependencyHealth {
  return { state, observedAt }
}

describe("GET /api/health/summary", () => {
  afterEach(() => vi.resetAllMocks())

  it("returns 401 before reading dependencies when unauthenticated", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" })
    const response = await GET()
    expect(response.status).toBe(401)
    expect(getDependencyHealthSummary).not.toHaveBeenCalled()
  })

  it("allows viewers and returns only state and observedAt", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "viewer" } } } as never)
    vi.mocked(getDependencyHealthSummary).mockResolvedValue(summary("ok"))

    const response = await GET()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({ state: "ok", observedAt })
    expect(Object.keys(body).sort()).toEqual(["observedAt", "state"])
    expect(requireRole).toHaveBeenCalledWith("cluster-admin", "developer", "viewer", "guest")
  })

  it("does not leak dependency names or diagnostics when a probe fails", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "viewer" } } } as never)
    vi.mocked(getDependencyHealthSummary).mockResolvedValue(summary("unavailable"))

    const response = await GET()
    const text = await response.text()
    expect(text).toBe(JSON.stringify({ state: "unavailable", observedAt }))
    expect(text).not.toMatch(/kubernetes|private\.internal|timeout|detail|reason/i)
  })
})
