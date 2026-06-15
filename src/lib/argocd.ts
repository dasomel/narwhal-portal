import { cacheGet, cacheSet } from "./valkey"
import { getUserScope } from "./role-filter"

const ARGOCD_URL = process.env.ARGOCD_URL ?? "http://localhost:8080"
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? ""

// H-3: ArgoCD project allowlist for the `developer` role.
// Empty (default) means developers are denied any sync/rollback unless
// they have an explicit role-filter mapping (config/role-filter.json).
const DEVELOPER_PROJECTS = (process.env.ARGOCD_DEVELOPER_PROJECTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

// ArgoCD 앱 목록에서 숨길 앱 이름 (APISIX 내장 대시보드 등 중복 노출 방지)
const HIDDEN_APPS = ["apisix-dashboard"]

export interface ArgoApp {
  metadata: { name: string; namespace?: string; creationTimestamp?: string; annotations?: Record<string, string> }
  spec: {
    project?: string
    source?: { repoURL?: string; targetRevision?: string; chart?: string; path?: string }
    destination?: { server?: string; namespace?: string }
  }
  status: {
    sync: { status: string; revision?: string }
    health: { status: string; message?: string }
    operationState?: {
      phase?: string
      message?: string
      startedAt?: string
      finishedAt?: string
      syncResult?: { revision?: string }
    }
    reconciledAt?: string
    history?: Array<{
      id: number
      revision: string
      deployedAt: string
      source?: { repoURL?: string; targetRevision?: string }
    }>
    resources?: Array<{
      group?: string
      version: string
      kind: string
      namespace?: string
      name: string
      status?: string
      health?: { status?: string; message?: string }
    }>
  }
}

function argoFetch(path: string, timeout = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  return fetch(`${ARGOCD_URL}${path}`, {
    headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))
}

async function loadArgoApps(): Promise<ArgoApp[]> {
  const cached = await cacheGet<ArgoApp[]>("argocd:apps")
  if (cached) return cached
  const res = await argoFetch("/api/v1/applications")
  if (!res.ok) throw new Error(`ArgoCD API failed: ${res.status}`)
  const data = await res.json()
  const apps: ArgoApp[] = (data.items ?? []).filter((a: ArgoApp) => !HIDDEN_APPS.includes(a.metadata.name))
  await cacheSet("argocd:apps", apps, 10)
  return apps
}

export async function getArgoAppsOrThrow(): Promise<ArgoApp[]> {
  return loadArgoApps()
}

export async function getArgoApps(): Promise<ArgoApp[]> {
  try {
    return await loadArgoApps()
  } catch (err) {
    console.warn("[argocd] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}

export async function getArgoApp(name: string): Promise<ArgoApp | null> {
  const cacheKey = `argocd:app:${name}`
  const cached = await cacheGet<ArgoApp>(cacheKey)
  if (cached) return cached

  try {
    const res = await argoFetch(`/api/v1/applications/${encodeURIComponent(name)}`)
    if (!res.ok) return null
    const app: ArgoApp = await res.json()
    await cacheSet(cacheKey, app, 10)
    return app
  } catch {
    return null
  }
}

export type ScoreTier = "gold" | "silver" | "bronze" | "none"

export interface CatalogService {
  name: string
  project: string
  namespace: string
  repoURL: string
  revision: string
  syncStatus: string
  healthStatus: string
  lastDeployed: string | null
  resourceCount: number
  owner?: string
  runbookUrl?: string
  scoreTier?: ScoreTier
  scoreValue?: number
}

export function appToCatalogService(app: ArgoApp): CatalogService {
  const lastHistory = app.status.history?.at(-1)
  const annotations = app.metadata.annotations ?? {}
  return {
    name: app.metadata.name,
    project: app.spec.project ?? "default",
    namespace: app.spec.destination?.namespace ?? "default",
    repoURL: app.spec.source?.repoURL ?? "",
    revision: app.status.sync.revision?.slice(0, 7) ?? lastHistory?.revision?.slice(0, 7) ?? "-",
    syncStatus: app.status.sync.status,
    healthStatus: app.status.health.status,
    lastDeployed: lastHistory?.deployedAt ?? app.status.operationState?.finishedAt ?? null,
    resourceCount: app.status.resources?.length ?? 0,
    owner: annotations["narwhal.io/owner"],
    runbookUrl: annotations["narwhal.io/runbook"],
  }
}

export interface SyncResult {
  name: string
  syncStatus: string
  revision: string | null
}

export async function syncArgoApp(name: string): Promise<SyncResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  const res = await fetch(`${ARGOCD_URL}/api/v1/applications/${encodeURIComponent(name)}/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ARGOCD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`ArgoCD sync failed: ${res.status} ${body}`.trim())
  }

  const app: ArgoApp = await res.json()
  return {
    name: app.metadata.name,
    syncStatus: app.status.sync.status,
    revision: app.status.sync.revision?.slice(0, 7) ?? app.status.history?.at(-1)?.revision?.slice(0, 7) ?? null,
  }
}

export async function rollbackArgoApp(name: string, id: number): Promise<boolean> {
  try {
    const res = await fetch(`${ARGOCD_URL}/api/v1/applications/${encodeURIComponent(name)}/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ARGOCD_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// H-3: Project-scope authorization
// ---------------------------------------------------------------------------

export type ArgoActorRole = "cluster-admin" | "developer" | "viewer" | "guest"

export interface ArgoActor {
  role: ArgoActorRole
  groups?: string[]
}

export class ArgoForbiddenError extends Error {
  readonly status = 403 as const
  constructor(message: string) {
    super(message)
    this.name = "ArgoForbiddenError"
  }
}

export class ArgoNotFoundError extends Error {
  readonly status = 404 as const
  constructor(message: string) {
    super(message)
    this.name = "ArgoNotFoundError"
  }
}

/**
 * Returns the set of ArgoCD projects an actor is allowed to act upon.
 * - cluster-admin: unrestricted (returns null = wildcard)
 * - developer: union of `ARGOCD_DEVELOPER_PROJECTS` env + role-filter.json mapping
 * - viewer / guest: empty
 */
export function getAllowedProjects(actor: ArgoActor): Set<string> | null {
  if (actor.role === "cluster-admin") return null // unrestricted
  if (actor.role !== "developer") return new Set()

  const allowed = new Set<string>(DEVELOPER_PROJECTS)
  if (actor.groups && actor.groups.length > 0) {
    const scope = getUserScope(actor.groups)
    for (const p of scope.argocdProjects) allowed.add(p)
  }
  return allowed
}

/**
 * Asserts that the actor is allowed to operate on the given app's project.
 * Throws ArgoForbiddenError or ArgoNotFoundError on failure.
 */
export async function assertAppAccessible(name: string, actor: ArgoActor): Promise<ArgoApp> {
  const app = await getArgoApp(name)
  if (!app) throw new ArgoNotFoundError(`Application not found: ${name}`)
  const project = app.spec.project ?? "default"
  const allowed = getAllowedProjects(actor)
  if (allowed === null) return app // cluster-admin
  if (!allowed.has(project)) {
    throw new ArgoForbiddenError(
      `Forbidden: actor not authorized for ArgoCD project '${project}'`,
    )
  }
  return app
}

export async function getArgoStatus() {
  const apps = await getArgoApps()
  return {
    total: apps.length,
    synced: apps.filter((a) => a.status.sync.status === "Synced").length,
    outOfSync: apps.filter((a) => a.status.sync.status === "OutOfSync").length,
    degraded: apps.filter((a) => a.status.health.status === "Degraded").length,
    healthy: apps.filter((a) => a.status.health.status === "Healthy").length,
  }
}
