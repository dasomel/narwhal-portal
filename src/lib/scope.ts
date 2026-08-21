// One place that answers "what may this caller see", so the routes do not each
// assemble it from parts.
//
// role-filter.ts stays pure — it knows about configuration and labels, not about the
// Kubernetes API. This module is the seam: it fetches the namespace list (cached, so
// this is not an extra round trip) and hands back the resolved answer.

import { getNamespaces } from "./k8s-client"
import {
  getVisibilityScope,
  resolveNamespaceScope,
  scopeFingerprint,
  projectMatchesScope,
  type ResolvedNamespaceScope,
} from "./role-filter"

export interface EffectiveScope {
  /** Every namespace — cluster-admin, or a roleDefault of ["*"]. */
  all: boolean
  namespaces: Set<string>
  argocdProjects: string[]
  /**
   * Whether the caller has ANY scope — not whether they have a config entry.
   *
   * getVisibilityScope's own hasMapping means "matched a teamMapping or roleDefault",
   * which under the label model is the wrong question: a team can own namespaces
   * through narwhal.io/team with nothing in role-filter.json, and routes that gate on
   * the config answer would show those users an empty page while their namespaces sat
   * right there. /api/events/stream drops every event when this is false, so getting
   * it wrong is silent.
   */
  hasMapping: boolean
  /** Stable per-scope cache-key component. */
  fingerprint: string
  resolved: ResolvedNamespaceScope
}

export interface ScopeSession {
  groups?: string[]
  teams?: string[]
}

export async function getEffectiveScope(session: ScopeSession): Promise<EffectiveScope> {
  const groups = session.groups ?? []
  const teams = session.teams ?? []
  const scope = getVisibilityScope(groups, teams)

  // A caller with no mapping and no team sees nothing, and asking the API for the
  // namespace list to prove that is wasted work.
  if (!scope.hasMapping && scope.namespaces.length === 0) {
    const empty = { all: false, names: new Set<string>(), byLabel: new Set<string>(), byPattern: new Set<string>() }
    return {
      all: false,
      namespaces: empty.names,
      argocdProjects: scope.argocdProjects,
      hasMapping: false,
      fingerprint: scopeFingerprint(groups, teams),
      resolved: empty,
    }
  }

  const namespaces = await getNamespaces()
  const resolved = resolveNamespaceScope(namespaces, scope, teams)
  return {
    all: resolved.all,
    namespaces: resolved.names,
    argocdProjects: scope.argocdProjects,
    hasMapping: resolved.all || resolved.names.size > 0 || scope.argocdProjects.length > 0,
    fingerprint: scopeFingerprint(groups, teams),
    resolved,
  }
}

export function namespaceVisible(namespace: string, scope: EffectiveScope): boolean {
  return scope.all || scope.namespaces.has(namespace)
}

/**
 * Whether an ArgoCD application is visible: its project OR its destination namespace.
 *
 * Either alone is enough because the two describe the same tenancy from different
 * directions — a team owns namespaces, and projects are scoped to namespaces.
 * Requiring both would hide an app from the team that owns it whenever only one of
 * the two was configured.
 */
export function appVisible(project: string, namespace: string, scope: EffectiveScope): boolean {
  return projectMatchesScope(project, scope.argocdProjects) || namespaceVisible(namespace, scope)
}

/**
 * Alerts carry their namespace in a label, or none at all when cluster-wide.
 *
 * A namespace-less alert stays visible to everyone: node and control-plane alerts have
 * no namespace, and hiding them from every scoped user would blind the timeline to the
 * failures that matter most. This is the weakest point in the scoping story and it is
 * deliberate; the default-deny decision is tracked on #12.
 */
export function alertVisible(labels: Record<string, string | undefined>, scope: EffectiveScope): boolean {
  const ns = labels.namespace ?? labels.exported_namespace ?? ""
  return !ns || namespaceVisible(ns, scope)
}
