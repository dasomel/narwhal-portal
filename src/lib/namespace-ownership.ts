export type NamespaceOwnerVerdict = { ok: true; team: string } | { ok: false; status: 400 | 403; message: string }

/**
 * portal#15: resolves which team a self-service namespace request is stamped with,
 * and rejects a caller claiming ownership on behalf of a team they don't belong to.
 * The team label is an ownership claim, and ownership is what every downstream scope
 * check (namespaceVisible, appVisible, alertVisible) reads — trusting an unverified
 * client-supplied team here would let a developer claim a namespace into a team's
 * scope they aren't in, then act on it as that team via the resulting mapping.
 *
 * cluster-admin may set any team, including one they don't belong to (policy allows
 * cross-team provisioning for admins). A non-admin either claims one of their own
 * teams explicitly, or — with no `requestedTeam` — defaults to their first team.
 */
export function resolveNamespaceOwner(role: string, teams: string[], requestedTeam: string | null): NamespaceOwnerVerdict {
  if (requestedTeam && role !== "cluster-admin" && !teams.includes(requestedTeam)) {
    return {
      ok: false,
      status: 403,
      message: `Cannot create a namespace owned by '${requestedTeam}': you are not a member of that team`,
    }
  }
  const team = requestedTeam ?? teams[0]
  if (!team) {
    return { ok: false, status: 400, message: "No team to own this namespace: you are not a member of any team" }
  }
  return { ok: true, team }
}
