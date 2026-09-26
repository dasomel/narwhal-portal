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

export async function getAlerts(): Promise<Alert[]> {
  const cached = await cacheGet<Alert[]>(cacheKeys.alertmanagerActive())
  if (cached) return cached

  try {
    const res = await fetchWithPolicy(
      `${alertmanagerUrl()}/api/v2/alerts?active=true&silenced=false`,
      {},
      { timeoutMs: 5000 }
    )
    if (!res.ok) throw new Error(`Alertmanager failed: ${res.status}`)
    const alerts: Alert[] = await readJsonWithPolicy<Alert[]>(res)
    await cacheSet(cacheKeys.alertmanagerActive(), alerts, cacheTtl("alertmanagerActive"))
    return alerts
  } catch (err) {
    console.warn("[alertmanager] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}
