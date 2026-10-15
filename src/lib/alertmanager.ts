import { cacheGet, cacheSet } from "./valkey"
import { cacheKeys, cacheTtl } from "./cache-keys"
import { getDependencyUrl } from "./config"
import { fetchWithPolicy, readJsonWithPolicy } from "./http-client"

function alertmanagerUrl(): string {
  return getDependencyUrl("ALERTMANAGER_URL", "http://localhost:9093")
}

interface Alert {
  labels: Record<string, string>
  annotations: Record<string, string>
  status: { state: string }
  startsAt: string
}

export interface AlertmanagerSilence {
  id: string
  matchers: Array<{ name: string; value: string; isRegex?: boolean; isEqual?: boolean }>
  startsAt: string
  endsAt: string
  createdBy: string
  comment: string
  status?: { state: string }
}

export async function createSilence(
  matchers: Array<{ name: string; value: string; isRegex: boolean }>,
  durationMinutes: number,
  createdBy: string,
  comment: string
): Promise<string | null> {
  try {
    const now = new Date()
    const end = new Date(now.getTime() + durationMinutes * 60000)
    // POST is a mutation (creates a real silence) — never auto-retried (no
    // timeout before this migration; now gets the shared client's default 10s).
    const res = await fetchWithPolicy(
      `${alertmanagerUrl()}/api/v2/silences`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchers,
          startsAt: now.toISOString(),
          endsAt: end.toISOString(),
          createdBy,
          comment,
        }),
      },
      { retry: false }
    )
    if (!res.ok) return null
    const data = await readJsonWithPolicy<{ silenceID?: string }>(res)
    return data.silenceID ?? null
  } catch {
    return null
  }
}

export async function getSilence(silenceId: string): Promise<AlertmanagerSilence | null> {
  try {
    // GET, no timeout before this migration — now gets the shared client's default 10s.
    const res = await fetchWithPolicy(`${alertmanagerUrl()}/api/v2/silence/${encodeURIComponent(silenceId)}`)
    if (!res.ok) return null
    return await readJsonWithPolicy<AlertmanagerSilence>(res)
  } catch {
    return null
  }
}

export type AlertmanagerLookupFailure = "credential" | "forbidden" | "unavailable"

/**
 * Typed failure of the write-precondition lookup. Messages are fixed strings: they
 * never carry the Alertmanager URL/host (HttpClientError messages do), so a route
 * can return them directly (#47).
 */
export class AlertmanagerLookupError extends Error {
  constructor(readonly failure: AlertmanagerLookupFailure, message: string) {
    super(message)
    this.name = "AlertmanagerLookupError"
  }
}

/**
 * Write-precondition variant of getSilence (#47): null ONLY for an explicit 404
 * (silence does not exist). 401, 403, other non-2xx, timeout/network failure and a
 * body that is not a silence all throw AlertmanagerLookupError, because they are
 * unknown provider state, not "absent". getSilence keeps its swallow contract for
 * other callers.
 */
export async function getSilenceOrThrow(silenceId: string): Promise<AlertmanagerSilence | null> {
  let body: AlertmanagerSilence
  try {
    const res = await fetchWithPolicy(`${alertmanagerUrl()}/api/v2/silence/${encodeURIComponent(silenceId)}`)
    if (res.status === 404) return null
    if (res.status === 401) throw new AlertmanagerLookupError("credential", "Alertmanager rejected the portal credentials")
    if (res.status === 403) throw new AlertmanagerLookupError("forbidden", "Alertmanager denied access to the silence")
    if (!res.ok) throw new AlertmanagerLookupError("unavailable", `Alertmanager silence lookup failed: ${res.status}`)
    body = await readJsonWithPolicy<AlertmanagerSilence>(res)
  } catch (err) {
    if (err instanceof AlertmanagerLookupError) throw err
    throw new AlertmanagerLookupError("unavailable", "Alertmanager is unreachable")
  }
  if (typeof body?.id !== "string" || typeof body.createdBy !== "string" || !Array.isArray(body.matchers)) {
    throw new AlertmanagerLookupError("unavailable", "Alertmanager returned a malformed silence")
  }
  return body
}

export async function deleteSilence(silenceId: string): Promise<boolean> {
  try {
    // DELETE mutates alertmanager's silence state — retry: false explicitly,
    // same as the other providers' mutation calls (no timeout before this
    // migration; now gets the shared client's default 10s).
    const res = await fetchWithPolicy(
      `${alertmanagerUrl()}/api/v2/silence/${encodeURIComponent(silenceId)}`,
      { method: "DELETE" },
      { retry: false }
    )
    return res.ok
  } catch {
    return false
  }
}

/**
 * Throws on provider failure instead of returning []. Aggregators that turn an
 * empty alert list into "no incidents" (platform-status) must use this so an
 * unreachable Alertmanager is not reported as a healthy platform (#53).
 */
export async function getAlertsOrThrow(): Promise<Alert[]> {
  const cached = await cacheGet<Alert[]>(cacheKeys.alertmanagerActive())
  if (cached) return cached

  const res = await fetchWithPolicy(
    `${alertmanagerUrl()}/api/v2/alerts?active=true&silenced=false`,
    {},
    { timeoutMs: 5000 }
  )
  if (!res.ok) throw new Error(`Alertmanager failed: ${res.status}`)
  const alerts: Alert[] = await readJsonWithPolicy<Alert[]>(res)
  await cacheSet(cacheKeys.alertmanagerActive(), alerts, cacheTtl("alertmanagerActive"))
  return alerts
}

export async function getAlerts(): Promise<Alert[]> {
  try {
    return await getAlertsOrThrow()
  } catch (err) {
    console.warn("[alertmanager] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}
