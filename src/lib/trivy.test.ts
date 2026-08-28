import { describe, it, expect, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { computeVulnDbFreshness } from "./trivy"

describe("Vulnerability DB Freshness (Issue #75)", () => {
  it("marks a fresh timestamp (< 14 days) as fresh", () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const freshness = computeVulnDbFreshness(recent)
    expect(freshness.status).toBe("fresh")
    expect(freshness.dbAgeDays).toBe(2)
  })

  it("marks a stale timestamp (14-29 days) as stale", () => {
    const stale = new Date(Date.now() - 18 * 24 * 60 * 60 * 1000).toISOString()
    const freshness = computeVulnDbFreshness(stale)
    expect(freshness.status).toBe("stale")
    expect(freshness.dbAgeDays).toBe(18)
  })

  it("marks an outdated timestamp (>= 30 days) as critical", () => {
    const critical = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
    const freshness = computeVulnDbFreshness(critical)
    expect(freshness.status).toBe("critical")
    expect(freshness.dbAgeDays).toBe(35)
  })
})
