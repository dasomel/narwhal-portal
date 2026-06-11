import { cacheGet, cacheSet } from "./valkey"

const GITEA_URL = process.env.GITEA_URL ?? "http://gitea-http.devtools.svc.cluster.local:3000"

/**
 * Retrieves the commit timestamp from the in-cluster Gitea API.
 * Follows spec's graceful-degradation rules exactly (returns null, never throws).
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
    const url = `${GITEA_URL}/api/v1/repos/gitea-admin/narwhal-gitops/git/commits/${encodeURIComponent(sha)}`
    
    const res = await fetch(url, {
      next: { revalidate: 0 },
      signal: controller.signal,
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
