import { describe, expect, it } from "vitest"
import { checkSilenceScope } from "./alert-silence-scope"
import type { EffectiveScope } from "./scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

function fakeScope(overrides: Partial<EffectiveScope> = {}): EffectiveScope {
  return {
    all: false,
    namespaces: new Set(["team-a"]),
    argocdProjects: [],
    hasMapping: true,
    fingerprint: "test",
    resolved: { all: false, names: new Set(["team-a"]), byLabel: new Set(), byPattern: new Set() },
    clusterId: DEFAULT_CLUSTER_ID,
    ...overrides,
  }
}

describe("checkSilenceScope — catch-all regex rejection (applies to every role)", () => {
  it("rejects a catch-all regex matcher for cluster-admin too", () => {
    const verdict = checkSilenceScope([{ name: "alertname", value: ".*", isRegex: true }], "cluster-admin", fakeScope())
    expect(verdict).toEqual({ ok: false, status: 400, message: expect.stringContaining("catch-all") })
  })

  it("rejects a `(.+)` catch-all variant", () => {
    const verdict = checkSilenceScope([{ name: "alertname", value: "(.+)", isRegex: true }], "cluster-admin", fakeScope())
    expect(verdict.ok).toBe(false)
  })

  it("allows a narrow regex", () => {
    const verdict = checkSilenceScope(
      [
        { name: "namespace", value: "team-a", isRegex: false },
        { name: "alertname", value: "High.*Latency", isRegex: true },
      ],
      "developer",
      fakeScope(),
    )
    expect(verdict).toEqual({ ok: true })
  })
})

describe("checkSilenceScope — cluster-admin", () => {
  it("allows a namespace-less (global) silence", () => {
    const verdict = checkSilenceScope([{ name: "alertname", value: "NodeDown", isRegex: false }], "cluster-admin", fakeScope())
    expect(verdict).toEqual({ ok: true })
  })

  it("allows any namespace regardless of scope", () => {
    const verdict = checkSilenceScope(
      [{ name: "namespace", value: "team-b", isRegex: false }],
      "cluster-admin",
      fakeScope({ namespaces: new Set(["team-a"]) }),
    )
    expect(verdict).toEqual({ ok: true })
  })
})

describe("checkSilenceScope — non-admin roles", () => {
  it("rejects a namespace-less (global) silence", () => {
    const verdict = checkSilenceScope([{ name: "alertname", value: "NodeDown", isRegex: false }], "developer", fakeScope())
    expect(verdict).toEqual({ ok: false, status: 403, message: expect.stringContaining("global") })
  })

  it("rejects a regex namespace matcher", () => {
    const verdict = checkSilenceScope(
      [{ name: "namespace", value: "team-.*", isRegex: true }],
      "developer",
      fakeScope(),
    )
    expect(verdict).toEqual({ ok: false, status: 403, message: expect.stringContaining("exact match") })
  })

  it("rejects a namespace outside the caller's scope (cross-team)", () => {
    const verdict = checkSilenceScope(
      [{ name: "namespace", value: "team-b", isRegex: false }],
      "developer",
      fakeScope({ namespaces: new Set(["team-a"]) }),
    )
    expect(verdict).toEqual({ ok: false, status: 403, message: expect.stringContaining("team-b") })
  })

  it("allows an exact-match namespace matcher within the caller's scope", () => {
    const verdict = checkSilenceScope(
      [{ name: "namespace", value: "team-a", isRegex: false }],
      "developer",
      fakeScope({ namespaces: new Set(["team-a"]) }),
    )
    expect(verdict).toEqual({ ok: true })
  })

  it("rejects when the caller has no scope mapping at all", () => {
    const verdict = checkSilenceScope(
      [{ name: "namespace", value: "team-a", isRegex: false }],
      "developer",
      fakeScope({ hasMapping: false, namespaces: new Set() }),
    )
    expect(verdict.ok).toBe(false)
  })

  it("applies the same rules to viewer/guest as developer", () => {
    const event = [{ name: "namespace", value: "team-b", isRegex: false }]
    expect(checkSilenceScope(event, "viewer", fakeScope({ namespaces: new Set(["team-a"]) })).ok).toBe(false)
    expect(checkSilenceScope(event, "guest", fakeScope({ namespaces: new Set(["team-a"]) })).ok).toBe(false)
  })
})
