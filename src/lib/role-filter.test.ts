import { describe, expect, it } from "vitest"
import { alertMatchesScope, appMatchesScope, namespaceMatchesScope, projectMatchesScope, scopeFingerprint } from "./role-filter"

const admin = { namespaces: ["*"], argocdProjects: ["*"] }
const team = { namespaces: ["platform-*", "monitoring"], argocdProjects: ["platform"] }
const guest = { namespaces: [] as string[], argocdProjects: [] as string[] }

describe("namespaceMatchesScope", () => {
  it("wildcard matches anything", () => expect(namespaceMatchesScope("iam", ["*"])).toBe(true))
  it("prefix matches", () => expect(namespaceMatchesScope("platform-system", ["platform-*"])).toBe(true))
  it("prefix does not over-match", () => expect(namespaceMatchesScope("iam", ["platform-*"])).toBe(false))
  it("empty scope matches nothing", () => expect(namespaceMatchesScope("anything", [])).toBe(false))
})

describe("projectMatchesScope", () => {
  it("wildcard", () => expect(projectMatchesScope("default", ["*"])).toBe(true))
  it("exact", () => expect(projectMatchesScope("platform", ["platform"])).toBe(true))
  it("miss", () => expect(projectMatchesScope("apps", ["platform"])).toBe(false))
})

describe("appMatchesScope", () => {
  it("admin sees everything", () => expect(appMatchesScope("apps", "iam", admin)).toBe(true))
  it("team sees its project", () => expect(appMatchesScope("platform", "iam", team)).toBe(true))
  it("team sees its namespace", () => expect(appMatchesScope("apps", "platform-system", team)).toBe(true))
  it("team sees neither -> hidden", () => expect(appMatchesScope("apps", "iam", team)).toBe(false))
  it("guest sees nothing", () => expect(appMatchesScope("default", "default", guest)).toBe(false))
})

describe("alertMatchesScope", () => {
  it("namespaced alert in scope", () => expect(alertMatchesScope({ namespace: "monitoring" }, team)).toBe(true))
  it("namespaced alert out of scope", () => expect(alertMatchesScope({ namespace: "iam" }, team)).toBe(false))
  it("exported_namespace is honoured", () => expect(alertMatchesScope({ exported_namespace: "iam" }, team)).toBe(false))
  // Documented fail-open: cluster-wide alerts have no namespace label.
  it("cluster-wide alert is visible to a scoped user", () => expect(alertMatchesScope({}, team)).toBe(true))
  it("cluster-wide alert is visible to a guest too", () => expect(alertMatchesScope({}, guest)).toBe(true))
})

describe("scopeFingerprint", () => {
  it("is order independent", () =>
    expect(scopeFingerprint(["a", "b"], ["t"])).toBe(scopeFingerprint(["b", "a"], ["t"])))
  it("separates different scopes", () =>
    expect(scopeFingerprint(["developer"], ["platform-team"])).not.toBe(scopeFingerprint(["developer"], ["frontend-team"])))
  it("does not confuse a group with a team of the same name", () =>
    expect(scopeFingerprint(["platform-team"], [])).not.toBe(scopeFingerprint([], ["platform-team"])))

  // Regression: the previous implementation flattened teams into one sorted list as
  // `team:<name>`, so a group literally called "team:platform" hashed identically to
  // membership in the team "platform" — a cross-tenant cache hit. Verified colliding
  // before the fix.
  it("does not confuse a group named 'team:x' with membership in team x", () =>
    expect(scopeFingerprint(["team:platform"], [])).not.toBe(scopeFingerprint([], ["platform"])))

  it("does not let a comma in a name forge another scope", () =>
    expect(scopeFingerprint(["a,b"], [])).not.toBe(scopeFingerprint(["a", "b"], [])))

  it("is a sha256 prefix, not a 32-bit rolling hash", () =>
    expect(scopeFingerprint(["developer"], [])).toMatch(/^[0-9a-f]{32}$/))
})
