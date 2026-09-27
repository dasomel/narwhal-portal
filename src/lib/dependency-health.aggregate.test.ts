import { describe, expect, it } from "vitest"
import { aggregateDependencyHealth, type DependencyStatus } from "./dependency-health"

const observedAt = "2026-09-28T00:00:00.000Z"

function status(dependency: DependencyStatus["dependency"], state: DependencyStatus["state"]): DependencyStatus {
  return { dependency, state, observedAt, detail: "https://private.internal/path", reason: "timeout" }
}

describe("aggregateDependencyHealth", () => {
  it.each([
    ["all ok", [status("kubernetes", "ok"), status("argocd", "ok")], "ok"],
    ["empty results", [status("prometheus", "empty")], "ok"],
    ["no dependencies", [], "ok"],
    ["partial core", [status("kubernetes", "partial")], "degraded"],
    ["stale core", [status("prometheus", "stale")], "degraded"],
    ["unavailable optional", [status("argocd", "unavailable")], "degraded"],
    ["unauthorized optional", [status("gitea", "unauthorized")], "degraded"],
    ["unavailable core", [status("kubernetes", "unavailable")], "unavailable"],
    ["unauthorized core", [status("valkey", "unauthorized")], "unavailable"],
    ["core outage dominates optional state", [status("prometheus", "unavailable"), status("argocd", "partial")], "unavailable"],
  ] as const)("returns %s aggregate state", (_label, statuses, state) => {
    expect(aggregateDependencyHealth(statuses)).toEqual({ state, observedAt: statuses[0]?.observedAt ?? expect.any(String) })
  })
})
