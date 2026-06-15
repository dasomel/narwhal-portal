import { cacheGet, cacheSet } from "./valkey"

const ALERTMANAGER_URL = process.env.ALERTMANAGER_URL ?? "http://localhost:9093"

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
    const res = await fetch(`${ALERTMANAGER_URL}/api/v2/silences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchers,
        startsAt: now.toISOString(),
        endsAt: end.toISOString(),
        createdBy,
        comment,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.silenceID ?? null
  } catch {
    return null
  }
}

export async function getSilence(silenceId: string): Promise<AlertmanagerSilence | null> {
  try {
    const res = await fetch(`${ALERTMANAGER_URL}/api/v2/silence/${encodeURIComponent(silenceId)}`)
    if (!res.ok) return null
    return (await res.json()) as AlertmanagerSilence
  } catch {
    return null
  }
}

export async function deleteSilence(silenceId: string): Promise<boolean> {
  try {
    const res = await fetch(`${ALERTMANAGER_URL}/api/v2/silence/${encodeURIComponent(silenceId)}`, {
      method: "DELETE",
    })
    return res.ok
  } catch {
    return false
  }
}

export async function getAlerts(): Promise<Alert[]> {
  const cached = await cacheGet<Alert[]>("alerts:active")
  if (cached) return cached

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${ALERTMANAGER_URL}/api/v2/alerts?active=true&silenced=false`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`Alertmanager failed: ${res.status}`)
    const alerts: Alert[] = await res.json()
    await cacheSet("alerts:active", alerts, 15)
    return alerts
  } catch (err) {
    console.warn("[alertmanager] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}
