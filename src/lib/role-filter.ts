import { readFileSync } from "fs"
import { join } from "path"
import { createHash } from "node:crypto"

interface TeamMapping {
  group: string
  namespaces: string[]
  argocdProjects: string[]
}

interface RoleDefault {
  namespaces: string[]
  argocdProjects: string[]
}

interface RoleFilterConfig {
  roleDefaults?: Record<string, RoleDefault>
  teamMappings?: TeamMapping[]
  // legacy key (pre-rename) — still honored so old configs keep working
  groupMappings?: TeamMapping[]
}

export interface UserScope {
  groups: string[]
  namespaces: string[]
  argocdProjects: string[]
}

let _config: RoleFilterConfig | null = null

function loadConfig(): RoleFilterConfig {
  if (_config) return _config
  try {
    const configPath = join(process.cwd(), "config", "role-filter.json")
    const raw = readFileSync(configPath, "utf-8")
    _config = JSON.parse(raw) as RoleFilterConfig
  } catch (err) {
    console.warn("[role-filter] Could not load config/role-filter.json, using empty config:", (err as Error).message)
    _config = {}
  }
  return _config
}

function teamMappingsOf(config: RoleFilterConfig): TeamMapping[] {
  return config.teamMappings ?? config.groupMappings ?? []
}

function matchesNamespacePattern(pattern: string, namespace: string): boolean {
  if (pattern.endsWith("*")) {
    return namespace.startsWith(pattern.slice(0, -1))
  }
  return pattern === namespace
}

// The label a Namespace carries to say who owns it. This is the source of truth for
// tenancy: the portal reads it here, the cluster reads it in the RoleBinding that a
// tenant file ships (see narwhal resources/tenants/), and the portal writes it when it
// opens a namespace request. One fact on the governed object, rather than a list in a
// config file that drifts from the cluster it describes.
export const TEAM_LABEL = "narwhal.io/team"

export interface LabelledNamespace {
  name: string
  labels: Record<string, string>
}

export function namespaceOwnedBy(ns: LabelledNamespace, teams: string[]): boolean {
  const owner = ns.labels?.[TEAM_LABEL]
  return Boolean(owner) && teams.includes(owner)
}

export interface ResolvedNamespaceScope {
  /** Every namespace, present and future — cluster-admin, or a roleDefault of ["*"]. */
  all: boolean
  names: Set<string>
  /** How each name got in, for the "why can I see this" question. */
  byLabel: Set<string>
  byPattern: Set<string>
}

/**
 * Turns a scope into the concrete namespaces a caller may see.
 *
 * Takes the namespace list as an argument rather than fetching it, so this stays pure
 * and testable and role-filter.ts keeps its zero dependencies on the Kubernetes client.
 * Callers already hold the list — getNamespaces() is cached — so this costs nothing.
 *
 * BOTH sources count, deliberately. Label ownership is where this is going, but every
 * namespace that predates the tenant flow carries no narwhal.io/team label, and a pure
 * label model would show existing team members nothing on the day it shipped. The
 * config patterns stay as the migration path and can be emptied per team once its
 * namespaces are labelled — at which point this function keeps working unchanged.
 */
export function resolveNamespaceScope(
  namespaces: LabelledNamespace[],
  scope: Pick<UserScope, "namespaces">,
  teams: string[],
): ResolvedNamespaceScope {
  if (scope.namespaces.includes("*")) {
    return {
      all: true,
      names: new Set(namespaces.map((n) => n.name)),
      byLabel: new Set(),
      byPattern: new Set(namespaces.map((n) => n.name)),
    }
  }
  const byLabel = new Set<string>()
  const byPattern = new Set<string>()
  for (const ns of namespaces) {
    if (namespaceOwnedBy(ns, teams)) byLabel.add(ns.name)
    else if (namespaceMatchesScope(ns.name, scope.namespaces)) byPattern.add(ns.name)
  }
  return { all: false, names: new Set([...byLabel, ...byPattern]), byLabel, byPattern }
}

export function namespaceMatchesScope(namespace: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesNamespacePattern(p, namespace))
}

export function projectMatchesScope(project: string, patterns: string[]): boolean {
  return patterns.includes("*") || patterns.includes(project)
}

// One predicate for "may this caller see this ArgoCD application", so the routes
// that answer it cannot drift apart. /api/my-apps, /api/catalog and /api/events all
// decide the same question and used to each decide it in their own inline
// expression — which is how /api/catalog ended up not deciding it at all.
//
// An app is visible when EITHER its project or its destination namespace is in
// scope. Either alone is sufficient because the two mappings describe the same
// tenancy from different directions: a team owns namespaces, and ArgoCD projects
// are scoped to namespaces. Requiring both would hide an app from the team that
// owns it whenever only one of the two was configured.
// Alerts carry their namespace in a label, or carry none at all when they are
// cluster-wide. A namespace-less alert is currently shown to everyone with any
// scope — that is a deliberate fail-open, because node and control-plane alerts
// have no namespace and hiding them from every scoped user would leave the
// timeline blind to exactly the failures that matter most.
//
// It is also the weakest point in the scoping story, and it lives here rather than
// inline in each route so the default-deny decision tracked on #12 can be made in
// one place instead of three.
export function alertMatchesScope(
  labels: Record<string, string | undefined>,
  scope: Pick<UserScope, "namespaces">,
): boolean {
  const ns = labels.namespace ?? labels.exported_namespace ?? ""
  return !ns || namespaceMatchesScope(ns, scope.namespaces)
}

// Stable fingerprint of a caller's effective scope, for cache keys.
//
// A route that caches a SCOPED result must key on the scope, or the first caller's
// view is served to everyone behind them. /api/events cached its fully-rendered
// timeline under the single key "events:timeline", which is that bug in the form it
// takes when the filtering is added later and the cache is not revisited.
//
// TWO THINGS THIS GETS RIGHT that the version it replaces did not — it was lifted
// from a private hashGroups in /api/my-apps, where it keyed a per-user cache and the
// stakes were lower:
//
//  1. It is SHA-256, not a 32-bit rolling hash. A 32-bit digest collides by birthday
//     at a few tens of thousands of distinct scopes, and a collision here hands one
//     tenant another tenant's cached timeline. The hash is not a security primitive
//     on its own, but the consequence of a collision is a cross-tenant read, so the
//     cost of a real digest is worth paying.
//  2. The two lists are separated structurally, not by a prefix. The old form
//     flattened teams as `team:<name>` into one sorted list, so a GROUP literally
//     named "team:platform" produced the same digest as membership in the TEAM
//     "platform" — verified, not hypothetical. JSON-encoding two sorted arrays
//     cannot express one as the other.
export function scopeFingerprint(groups: string[], teams: string[]): string {
  const canonical = JSON.stringify([[...groups].sort(), [...teams].sort()])
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32)
}

export function appMatchesScope(
  project: string,
  namespace: string,
  scope: Pick<UserScope, "namespaces" | "argocdProjects">,
): boolean {
  return projectMatchesScope(project, scope.argocdProjects) || namespaceMatchesScope(namespace, scope.namespaces)
}

// STRICT authz scope (ArgoCD project authorization via argocd.ts).
// Mapping-only; NO role defaults. Behavior is unchanged from the original getUserScope
// except the config key was renamed groupMappings -> teamMappings (legacy still read).
export function getUserScope(groups: string[]): UserScope & { hasMapping: boolean } {
  const config = loadConfig()
  const matchedGroups: string[] = []
  const namespacePatternsSet = new Set<string>()
  const argocdProjectsSet = new Set<string>()

  for (const mapping of teamMappingsOf(config)) {
    if (groups.includes(mapping.group)) {
      matchedGroups.push(mapping.group)
      for (const ns of mapping.namespaces) namespacePatternsSet.add(ns)
      for (const proj of mapping.argocdProjects) argocdProjectsSet.add(proj)
    }
  }

  return {
    groups: matchedGroups,
    namespaces: Array.from(namespacePatternsSet),
    argocdProjects: Array.from(argocdProjectsSet),
    hasMapping: matchedGroups.length > 0,
  }
}

// VISIBILITY scope (my-apps + events SSE stream — read-only "what you can SEE").
// Precedence: cluster-admin -> everything; else matching team mappings (custom B);
// else the highest-priority role's default scope (A); else (guest) -> none.
const ROLE_PRIORITY = ["cluster-admin", "developer", "viewer"] as const

export function getVisibilityScope(
  roleGroups: string[],
  teamGroups: string[] = [],
): UserScope & { hasMapping: boolean } {
  const config = loadConfig()

  // 1. cluster-admin always sees all.
  if (roleGroups.includes("cluster-admin")) {
    return { groups: ["cluster-admin"], namespaces: ["*"], argocdProjects: ["*"], hasMapping: true }
  }

  // 2. Team mappings take precedence when any match (custom B).
  const matchedTeams: string[] = []
  const namespacePatternsSet = new Set<string>()
  const argocdProjectsSet = new Set<string>()
  for (const mapping of teamMappingsOf(config)) {
    if (teamGroups.includes(mapping.group)) {
      matchedTeams.push(mapping.group)
      for (const ns of mapping.namespaces) namespacePatternsSet.add(ns)
      for (const proj of mapping.argocdProjects) argocdProjectsSet.add(proj)
    }
  }
  if (matchedTeams.length > 0) {
    return {
      groups: matchedTeams,
      namespaces: Array.from(namespacePatternsSet),
      argocdProjects: Array.from(argocdProjectsSet),
      hasMapping: true,
    }
  }

  // 3. Role default (A) for the highest-priority role held.
  const defaults = config.roleDefaults ?? {}
  for (const role of ROLE_PRIORITY) {
    if (roleGroups.includes(role) && defaults[role]) {
      const d = defaults[role]
      return {
        groups: [role],
        namespaces: [...d.namespaces],
        argocdProjects: [...d.argocdProjects],
        hasMapping: d.namespaces.length > 0 || d.argocdProjects.length > 0,
      }
    }
  }

  // 4. guest / no mapping.
  return { groups: [], namespaces: [], argocdProjects: [], hasMapping: false }
}
