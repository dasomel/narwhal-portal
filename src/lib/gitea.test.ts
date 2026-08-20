import { describe, expect, it } from "vitest"
import { tenantManifest, tenantPath } from "./gitea"

// The live half of this flow — branch push, PR creation, the 409 on a duplicate —
// needs a Gitea to talk to and is verified against a scratch instance by hand; it is
// not asserted here because a CI test that needs a server is a flaky test. What IS
// asserted is the part that is pure and the part that silently matters: the manifest
// a merge applies to the cluster.
describe("tenantPath", () => {
  it("matches the layout the tenants Application recurses over", () =>
    expect(tenantPath("team-a", "dev-alpha")).toBe("resources/tenants/team-a/dev-alpha.yaml"))
})

describe("tenantManifest", () => {
  const m = tenantManifest("dev-alpha", "team-a", "alice@example.com")

  it("labels the namespace with the owning team", () =>
    expect(m).toContain("narwhal.io/team: team-a"))

  // Without this the team can see the namespace and change nothing in it: the
  // cluster-wide `developer` role is read-only by design (narwhal 7551c21).
  it("binds developer-workload-admin, not the read-only developer role", () => {
    expect(m).toContain("name: developer-workload-admin")
    expect(m).not.toMatch(/name: developer$/m)
  })

  it("binds it to the requesting team's OIDC group, not a wildcard", () =>
    expect(m).toContain('name: "oidc:team-a"'))

  it("carries a quota — an unbounded namespace starves its neighbours", () => {
    expect(m).toContain("kind: ResourceQuota")
    expect(m).toContain("requests.memory: 4Gi")
  })

  it("records who asked, since the merge is the audit record", () =>
    expect(m).toContain("alice@example.com"))

  it("is three documents: Namespace, RoleBinding, ResourceQuota", () =>
    expect(m.split(/^---$/m)).toHaveLength(3))
})
