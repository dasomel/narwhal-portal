import { readFileSync } from "fs"
import { join } from "path"

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

export function namespaceMatchesScope(namespace: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesNamespacePattern(p, namespace))
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
