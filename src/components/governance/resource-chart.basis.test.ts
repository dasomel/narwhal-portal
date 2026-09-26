import { describe, expect, it } from "vitest"
import { isScopedBasis } from "./resource-chart"
import { t } from "@/lib/i18n"

// resource-chart.tsx has hooks (useState, useQuery) and this repo has no
// jsdom/testing-library setup for rendering hook-bearing components (see
// src/components/ui/route-loading-fallback.test.tsx for the one pattern that does
// exist, which only works for a plain stateless function). isScopedBasis is kept pure
// and exported so the branch decision behind "same 'CPU Usage' caption means two
// different things" has a test at all — the actual t() calls at each call site stay
// literal keys (never fed this function's output), so they don't need covering here.
describe("isScopedBasis", () => {
  it("is false for cluster-capacity (admin) and true for visible-requests (scoped)", () => {
    expect(isScopedBasis("cluster-capacity")).toBe(false)
    expect(isScopedBasis("visible-requests")).toBe(true)
  })
})

describe("resource-chart basis labels (ko+en)", () => {
  it("cluster-capacity and visible-requests use distinct label/tooltip text in both locales", () => {
    for (const locale of ["ko", "en"] as const) {
      // The discriminator: same underlying field (cpuPercent/memPercent), different
      // denominator (node capacity vs. visible-namespace requests) — the literal keys
      // each branch calls t() with must resolve to genuinely different text, not just
      // different key names.
      expect(t(locale, "resources.stat.cpuUsage")).not.toBe(t(locale, "resources.stat.cpuUsageScoped"))
      expect(t(locale, "resources.stat.memUsage")).not.toBe(t(locale, "resources.stat.memUsageScoped"))
      expect(t(locale, "resources.stat.usageTooltip.clusterCapacity")).not.toBe(
        t(locale, "resources.stat.usageTooltip.visibleRequests"),
      )
    }
  })
})
