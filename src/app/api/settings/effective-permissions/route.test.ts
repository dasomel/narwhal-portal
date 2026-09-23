import { describe, expect, it, vi } from "vitest"

// Portal #45: the RBAC role claim ("cluster-admin" / "developer" / "viewer") that a
// Keycloak group name typo silently rejects is a DIFFERENT failure from an unmapped
// TEAM claim — diagnoseClaims() in role-filter.ts only speaks to the latter, so
// `claims.fellBackToGuest` stays false even when the role claim itself was dropped.
// session.groupClaimStatus (narwhal#163) is the field that actually distinguishes
// "no groups claim at all" from "a role claim arrived but was rejected", but until
// this route surfaced it, the distinction only ever reached a server console.log —
// invisible to an admin diagnosing "why is this user's portal empty".
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { getNamespaces } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const baseSession = {
  user: { name: "Dev User", email: "dev@narwhal.local", role: "developer" as const },
  groups: ["developer"],
  teams: [] as string[],
}

describe("GET /api/settings/effective-permissions", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it("surfaces groupClaimStatus 'unknown_groups' when a role claim was rejected", async () => {
    vi.mocked(auth).mockResolvedValue({
      ...baseSession,
      groups: ["guest"],
      groupClaimStatus: "unknown_groups",
    } as never)
    vi.mocked(getNamespaces).mockResolvedValue([])
    const res = await GET()
    const body = await res.json()
    expect(body.claims.groupClaimStatus).toBe("unknown_groups")
    // The narwhal#163 bug this guards: a rejected ROLE claim must not read as a
    // clean "fell back to guest with no team either" state.
    expect(body.identity.role).toBe("developer")
  })

  it("reports 'no_groups' for a legitimate no-claims guest session", async () => {
    vi.mocked(auth).mockResolvedValue({
      ...baseSession,
      groups: ["guest"],
      groupClaimStatus: "no_groups",
    } as never)
    vi.mocked(getNamespaces).mockResolvedValue([])
    const res = await GET()
    const body = await res.json()
    expect(body.claims.groupClaimStatus).toBe("no_groups")
  })

  it("defaults to 'no_groups' when the session predates groupClaimStatus", async () => {
    vi.mocked(auth).mockResolvedValue({ ...baseSession } as never)
    vi.mocked(getNamespaces).mockResolvedValue([])
    const res = await GET()
    const body = await res.json()
    expect(body.claims.groupClaimStatus).toBe("no_groups")
  })

  it("reports 'ok' for a clean role match", async () => {
    vi.mocked(auth).mockResolvedValue({
      ...baseSession,
      groupClaimStatus: "ok",
    } as never)
    vi.mocked(getNamespaces).mockResolvedValue([])
    const res = await GET()
    const body = await res.json()
    expect(body.claims.groupClaimStatus).toBe("ok")
  })
})
