import { cacheGet, cacheSet } from "./valkey"

// Gitea client for the one thing the portal writes: a namespace request.
//
// The portal does NOT create namespaces. Its Kubernetes ServiceAccount has
// `namespaces: [get, list, watch]` and keeps it that way, because a namespace is a
// tenancy decision — who owns it, what quota it gets, which group may deploy into
// it — and those are decided by a person, not by whoever can reach the form.
//
// So a request becomes a pull request against the GitOps repository, and merging it
// is the approval. That is enforced on the server, not here: `portal-gitops` is
// deliberately absent from the repo's `main` push whitelist, so it can push a branch
// and nothing else. Verified against Gitea 1.26.2 — a push to main is rejected with
// "protected branch main", and merging its own PR returns 405 "Does not have enough
// approvals". If this file were rewritten to push straight to main it would fail.

const GITEA_URL = (process.env.GITEA_URL ?? "http://gitea-http.devtools.svc.cluster.local:3000").replace(/\/+$/, "")
const GITEA_OWNER = process.env.GITEA_OWNER ?? "gitea-admin"
const GITEA_REPO = process.env.GITEA_REPO ?? "narwhal-gitops"
const GITEA_TOKEN = process.env.GITEA_TOKEN ?? ""
const BASE_BRANCH = process.env.GITEA_BASE_BRANCH ?? "main"

export const giteaConfigured = Boolean(GITEA_URL && GITEA_OWNER && GITEA_REPO && GITEA_TOKEN)

export class GiteaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "GiteaError"
  }
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${GITEA_URL}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${GITEA_TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) {
    // Gitea answers with {"message": "..."}; keep it, since "namespace already
    // requested" and "token expired" are different problems for the caller.
    const detail = await res.text().catch(() => "")
    let message = detail
    try {
      message = (JSON.parse(detail) as { message?: string }).message ?? detail
    } catch {
      /* not JSON — use the raw body */
    }
    throw new GiteaError(message || res.statusText, res.status)
  }
  return (await res.json()) as T
}

/** resources/tenants/<team>/<namespace>.yaml — the layout the tenants Application recurses over. */
export const tenantPath = (team: string, namespace: string) =>
  `resources/tenants/${team}/${namespace}.yaml`

/**
 * The manifest a request adds. Three objects, because a Namespace on its own is a
 * namespace nobody can use: the label is what the portal and the RoleBinding both
 * read as ownership, the RoleBinding is what turns that into permission (the
 * cluster-wide `developer` role is read-only), and the quota is what keeps one
 * tenant from starving the rest.
 */
export function tenantManifest(namespace: string, team: string, requestedBy: string): string {
  return `# Requested through the Narwhal portal by ${requestedBy}.
# Generated file — change it by opening another pull request, not by editing in place.
apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    narwhal.io/team: ${team}
    app.kubernetes.io/managed-by: narwhal-gitops
    istio.io/dataplane-mode: none
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: developer-workload-admin
  namespace: ${namespace}
  labels:
    narwhal.io/team: ${team}
    app.kubernetes.io/managed-by: narwhal-gitops
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: developer-workload-admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: "oidc:${team}"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${namespace}-quota
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: narwhal-gitops
spec:
  hard:
    requests.cpu: "2"
    limits.cpu: "4"
    requests.memory: 4Gi
    limits.memory: 8Gi
    requests.storage: 20Gi
    persistentvolumeclaims: "5"
    pods: "20"
`
}

export interface TenantRequest {
  namespace: string
  team: string
  requestedBy: string
}

export interface TenantRequestResult {
  pullRequestUrl: string
  pullRequestNumber: number
  branch: string
  path: string
}

/**
 * Commits the tenant manifest onto a new branch and opens a pull request for it.
 *
 * Two calls, not three: Gitea's contents API takes `new_branch` and creates the
 * branch and the commit together, so there is no window where a branch exists with
 * nothing on it. `branch` stays the base — it is what the new branch is cut FROM,
 * not what is written to.
 */
export async function requestTenantNamespace(req: TenantRequest): Promise<TenantRequestResult> {
  const branch = `selfservice/${req.namespace}`
  const path = tenantPath(req.team, req.namespace)
  const repo = `/repos/${GITEA_OWNER}/${GITEA_REPO}`

  await api<unknown>(`${repo}/contents/${path}`, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(tenantManifest(req.namespace, req.team, req.requestedBy)).toString("base64"),
      message: `feat(tenant): request namespace ${req.namespace} for ${req.team}`,
      branch: BASE_BRANCH,
      new_branch: branch,
    }),
  })

  const pr = await api<{ number: number; html_url: string }>(`${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      head: branch,
      base: BASE_BRANCH,
      title: `Namespace request: ${req.namespace}`,
      body: [
        `Requested by **${req.requestedBy}** for team \`${req.team}\`.`,
        "",
        "Merging this grants the team a namespace, a `developer-workload-admin`",
        "RoleBinding in it, and the quota below. Check that the requester is",
        "actually in that team before approving — the portal verifies the claim",
        "against the caller's group membership, but the reviewer is the last check.",
      ].join("\n"),
    }),
  })

  return { pullRequestUrl: pr.html_url, pullRequestNumber: pr.number, branch, path }
}

/**
 * Retrieves the commit timestamp from the in-cluster Gitea API.
 * Follows spec's graceful-degradation rules exactly (returns null, never throws).
 *
 * NOW SENDS THE TOKEN. This read used to be anonymous and worked only because
 * narwhal-gitops was a public repository. It is private as of the GitOps hardening
 * (narwhal 52dbb8d), and an unauthenticated fetch returns 404 — which this function
 * would have degraded into "no timestamp" rather than an error, quietly emptying the
 * DORA lead-time metric. Same shape as ArgoCD's missing repository Secret: a consumer
 * with no credentials is a consumer relying on the repo being public.
 */
export async function getCommitTimestamp(sha: string): Promise<string | null> {
  if (!sha) return null
  const cacheKey = `dora:commit:${sha}`
  try {
    const cached = await cacheGet<string>(cacheKey)
    if (cached) return cached
  } catch (err) {
    console.warn("[gitea] Cache lookup failed:", err)
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const url = `${GITEA_URL}/api/v1/repos/${GITEA_OWNER}/${GITEA_REPO}/git/commits/${encodeURIComponent(sha)}`

    const res = await fetch(url, {
      next: { revalidate: 0 },
      signal: controller.signal,
      headers: GITEA_TOKEN ? { Authorization: `token ${GITEA_TOKEN}` } : {},
    }).finally(() => clearTimeout(timer))

    if (!res.ok) {
      console.warn(`[gitea] Failed to fetch commit ${sha}: status ${res.status}`)
      return null
    }

    const data = await res.json()
    const commitDate = data?.commit?.committer?.date || data?.commit?.author?.date || null
    if (commitDate) {
      try {
        await cacheSet(cacheKey, commitDate, 3600) // Cache for 1 hour
      } catch (err) {
        console.warn("[gitea] Cache save failed:", err)
      }
      return commitDate
    }
  } catch (err) {
    console.warn(`[gitea] Error fetching commit ${sha}:`, err)
  }
  return null
}
