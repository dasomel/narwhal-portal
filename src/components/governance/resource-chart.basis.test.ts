import { describe, expect, it } from "vitest"
import { basisLabelKeys } from "./resource-chart"
import { t } from "@/lib/i18n"

// resource-chart.tsx has hooks (useState, useQuery) and this repo has no
// jsdom/testing-library setup for rendering hook-bearing components (see
// src/components/ui/route-loading-fallback.test.tsx for the one pattern that does
// exist, which only works for a plain stateless function). basisLabelKeys is kept pure
// and exported specifically so the label/tooltip switch per basis — the actual fix for
// the "same 'CPU Usage' caption means two different things" finding — has a test at all.
describe("basisLabelKeys", () => {
  it("labels cluster-capacity basis as the cluster-wide caption, in both locales", () => {
    const keys = basisLabelKeys("cluster-capacity")
    expect(t("ko", keys.cpuLabelKey)).toBe("클러스터 CPU 사용률")
    expect(t("en", keys.cpuLabelKey)).toBe("Cluster CPU Usage")
    expect(t("ko", keys.memLabelKey)).toBe("클러스터 메모리 사용률")
    expect(t("en", keys.memLabelKey)).toBe("Cluster Memory Usage")
  })

  it("labels visible-requests basis distinctly from cluster-capacity, in both locales", () => {
    const clusterKeys = basisLabelKeys("cluster-capacity")
    const scopedKeys = basisLabelKeys("visible-requests")

    for (const locale of ["ko", "en"] as const) {
      // The discriminator: same underlying field (cpuPercent/memPercent), different
      // denominator (node capacity vs. visible-namespace requests) — the label text
      // must differ, not just the key name, or a scoped caller reads "Cluster CPU
      // Usage" over a number that is not cluster-wide.
      expect(t(locale, scopedKeys.cpuLabelKey)).not.toBe(t(locale, clusterKeys.cpuLabelKey))
      expect(t(locale, scopedKeys.memLabelKey)).not.toBe(t(locale, clusterKeys.memLabelKey))
      expect(t(locale, scopedKeys.tooltipKey)).not.toBe(t(locale, clusterKeys.tooltipKey))
    }
  })
})
