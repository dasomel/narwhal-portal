import { describe, expect, it } from "vitest"
import {
  alertMatchesScope,
  appMatchesScope,
  namespaceMatchesScope,
  namespaceOwnedBy,
  projectMatchesScope,
  resolveNamespaceScope,
  scopeFingerprint,
  TEAM_LABEL,
  diagnoseClaims,
  type LabelledNamespace,
} from "./role-filter"

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

const ns = (name: string, team?: string): LabelledNamespace => ({
  name,
  labels: team ? { [TEAM_LABEL]: team } : {},
})

describe("namespaceOwnedBy", () => {
  it("matches on the team label", () => expect(namespaceOwnedBy(ns("dev-a", "team-a"), ["team-a"])).toBe(true))
  it("rejects another team's namespace", () => expect(namespaceOwnedBy(ns("dev-a", "team-b"), ["team-a"])).toBe(false))
  it("an unlabelled namespace is owned by nobody", () => expect(namespaceOwnedBy(ns("iam"), ["team-a"])).toBe(false))
  // An empty label must not be treated as "owned by the team with an empty name".
  it("an empty label is not ownership", () =>
    expect(namespaceOwnedBy({ name: "x", labels: { [TEAM_LABEL]: "" } }, [""])).toBe(false))
})

describe("resolveNamespaceScope", () => {
  const all = [ns("dev-a", "team-a"), ns("dev-b", "team-b"), ns("iam"), ns("legacy-a")]

  it('["*"] resolves to every namespace', () => {
    const r = resolveNamespaceScope(all, { namespaces: ["*"] }, [])
    expect(r.all).toBe(true)
    expect(r.names.size).toBe(4)
  })

  it("a team sees the namespaces its label owns, and nothing else", () => {
    const r = resolveNamespaceScope(all, { namespaces: [] }, ["team-a"])
    expect([...r.names]).toEqual(["dev-a"])
    expect([...r.byLabel]).toEqual(["dev-a"])
    expect(r.byPattern.size).toBe(0)
  })

  // The migration path: namespaces created before the tenant flow carry no label, so
  // the config patterns still resolve them. Dropping this would empty every existing
  // team's view on the day the label model shipped.
  it("config patterns still resolve unlabelled namespaces", () => {
    const r = resolveNamespaceScope(all, { namespaces: ["legacy-*"] }, ["team-a"])
    expect([...r.names].sort()).toEqual(["dev-a", "legacy-a"])
    expect([...r.byLabel]).toEqual(["dev-a"])
    expect([...r.byPattern]).toEqual(["legacy-a"])
  })

  it("a pattern does not grant another team's labelled namespace by accident", () => {
    const r = resolveNamespaceScope(all, { namespaces: ["dev-*"] }, ["team-a"])
    // dev-b matches the pattern, so it is in scope — the pattern is an explicit grant.
    // What matters is that the label attribution stays truthful about why.
    expect(r.byLabel.has("dev-b")).toBe(false)
    expect(r.byPattern.has("dev-b")).toBe(true)
  })

  it("no teams and no patterns resolves to nothing", () => {
    const r = resolveNamespaceScope(all, { namespaces: [] }, [])
    expect(r.all).toBe(false)
    expect(r.names.size).toBe(0)
  })
})

// The failure this surfaces: a Keycloak group named `cluster-admins` is dropped by the
// RBAC allowlist, kept as a "team", matched by no mapping, and the session lands on
// guest — with nothing anywhere saying the claim was unrecognised.
describe("diagnoseClaims", () => {
  const owned = [ns("dev-a", "team-a")]

  it("a typo'd role claim is reported, not silently dropped", () => {
    const d = diagnoseClaims(["guest"], ["cluster-admins"], owned)
    expect(d.unmappedClaims).toEqual(["cluster-admins"])
    expect(d.fellBackToGuest).toBe(true)
  })

  it("a team that owns a namespace by label counts as mapped, with no config entry", () => {
    const d = diagnoseClaims(["developer"], ["team-a"], owned)
    expect(d.mappedTeams).toEqual(["team-a"])
    expect(d.unmappedClaims).toEqual([])
    expect(d.fellBackToGuest).toBe(false)
  })

  it("a team configured in role-filter.json counts as mapped", () => {
    const d = diagnoseClaims(["developer"], ["platform-team"], [])
    expect(d.mappedTeams).toEqual(["platform-team"])
    expect(d.unmappedClaims).toEqual([])
  })

  // guest is a real role but not one that grants anything; treating it as "has a role"
  // would report the fallback state as healthy, which is exactly what hides the bug.
  it("guest alone still counts as the fallback", () =>
    expect(diagnoseClaims(["guest"], [], []).fellBackToGuest).toBe(true))

  it("a real role claim is not the fallback", () =>
    expect(diagnoseClaims(["viewer"], [], []).fellBackToGuest).toBe(false))
})
