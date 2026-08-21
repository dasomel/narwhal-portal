import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getNamespaces } from "@/lib/k8s-client"
import { configuredMappings, diagnoseClaims, TEAM_LABEL } from "@/lib/role-filter"
import { getEffectiveScope } from "@/lib/scope"

export const dynamic = "force-dynamic"

export interface EffectivePermissions {
  identity: { name: string | null; email: string | null; role: string }
  /** Keycloak group claims, split by what the portal did with each. */
  claims: {
    roles: string[]
    mappedTeams: string[]
    unmappedClaims: string[]
    fellBackToGuest: boolean
  }
  /** Namespaces in scope, each with WHY it is in scope. */
  namespaces: Array<{ name: string; via: "label" | "pattern" | "all"; owner: string | null }>
  allNamespaces: boolean
  argocdProjects: string[]
  /** What the config file declares, so an empty result is distinguishable from an empty config. */
  configured: { teams: string[]; roleDefaults: Record<string, { namespaces: string[]; argocdProjects: string[] }> }
}

/**
 * The authorization chain for the calling user, with the reason for every entry.
 *
 * This is READ-ONLY and answers one question: "why can I see what I see". The chain —
 * Keycloak group -> portal role -> team -> namespace -> ArgoCD project — is assembled
 * from four places, and when a user reports an empty portal the useful information is
 * which of those four links is broken.
 *
 * The link that breaks most quietly is the first. Group claims are filtered through an
 * RBAC allowlist and anything unrecognised is dropped; a group named `cluster-admins`
 * instead of `cluster-admin` therefore produces a guest session with no error anywhere.
 * `claims.unmappedClaims` is that dropped set, surfaced rather than discarded, and
 * `fellBackToGuest` says whether the fallback actually happened.
 *
 * Every caller sees their OWN chain. There is no user parameter on purpose: reading
 * another user's authorization is an admin capability that needs the audit contract in
 * #11, and shipping it without that would be the kind of convenience that turns into a
 * finding.
 */
export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const groups = session.groups ?? []
  const teams = session.teams ?? []
  const namespaces = await getNamespaces()
  const scope = await getEffectiveScope(session)
  const diagnosis = diagnoseClaims(groups, teams, namespaces)
  const configured = configuredMappings()

  const labelOwner = new Map(namespaces.map((n) => [n.name, n.labels?.[TEAM_LABEL] ?? null]))
  const inScope = [...scope.namespaces].sort().map((name) => ({
    name,
    via: scope.all
      ? ("all" as const)
      : scope.resolved.byLabel.has(name)
        ? ("label" as const)
        : ("pattern" as const),
    owner: labelOwner.get(name) ?? null,
  }))

  const body: EffectivePermissions = {
    identity: {
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      role: session.user.role ?? "guest",
    },
    claims: diagnosis,
    namespaces: inScope,
    allNamespaces: scope.all,
    argocdProjects: scope.argocdProjects,
    configured: {
      teams: configured.teams,
      roleDefaults: configured.roleDefaults as EffectivePermissions["configured"]["roleDefaults"],
    },
  }
  return NextResponse.json(body)
}
