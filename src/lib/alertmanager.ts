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

// Write-outcome classes for silence create/delete (#47). Messages are fixed strings:
// they never carry the Alertmanager URL/host/token or response body, so the route can
// map them without leaking into responses or the operation event stream.
export class AlertmanagerSilenceRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Alertmanager rejected the silence mutation (HTTP ${status})`)
    this.name = "AlertmanagerSilenceRejectedError"
  }
}

export class AlertmanagerSilenceOutcomeUnknownError extends Error {
  constructor() {
    super("Alertmanager silence outcome unknown; change may have been applied, verify before retrying")
    this.name = "AlertmanagerSilenceOutcomeUnknownError"
  }
}

export class AlertmanagerSilenceNotFoundError extends Error {
  constructor() {
    super("Silence not found / already expired")
    this.name = "AlertmanagerSilenceNotFoundError"
  }
}

export class AlertmanagerCredentialError extends Error {
  constructor() {
    super("Alertmanager rejected the portal credentials")
    this.name = "AlertmanagerCredentialError"
  }
}

export class AlertmanagerForbiddenError extends Error {
  constructor() {
    super("Alertmanager denied access to the silence")
    this.name = "AlertmanagerForbiddenError"
  }
}

// Throws unless the mutation was accepted (2xx). Other 4xx = rejected before applying;
// 408, 5xx and anything else non-2xx = unknown (the mutation may have been applied).
function assertSilenceWriteAccepted(res: Response): void {
  if (res.ok) return
  if (res.status === 401) throw new AlertmanagerCredentialError()
  if (res.status === 403) throw new AlertmanagerForbiddenError()
  if (res.status >= 400 && res.status < 500 && res.status !== 408) throw new AlertmanagerSilenceRejectedError(res.status)
  throw new AlertmanagerSilenceOutcomeUnknownError()
}

export async function createSilence(
  matchers: Array<{ name: string; value: string; isRegex: boolean }>,
  durationMinutes: number,
  createdBy: string,
  comment: string
): Promise<string> {
  const now = new Date()
  const end = new Date(now.getTime() + durationMinutes * 60000)
  let res: Response
  try {
    // POST is a mutation (creates a real silence) — never auto-retried.
    res = await fetchWithPolicy(
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
  } catch {
    throw new AlertmanagerSilenceOutcomeUnknownError()
  }
  assertSilenceWriteAccepted(res)
  // A 2xx without a string id is not proof of a created silence: outcome unknown.
  let data: unknown
  try {
    data = await readJsonWithPolicy<unknown>(res)
  } catch {
    throw new AlertmanagerSilenceOutcomeUnknownError()
  }
  // Never return a value other than the one the server sent: an id with any whitespace
  // (empty, padded, inner) is untrustworthy, not something to trim (UUIDs have none).
  const silenceId = isRecord(data) ? data.silenceID : undefined
  if (typeof silenceId !== "string" || !/^\S+$/.test(silenceId)) throw new AlertmanagerSilenceOutcomeUnknownError()
  return silenceId
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
  if (!isValidSilence(body, silenceId)) {
    throw new AlertmanagerLookupError("unavailable", "Alertmanager returned a malformed silence")
  }
  return body
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Validates every field the caller dereferences or compares (id, createdBy, matchers[].name/value)
 * and binds the response to the requested id; fields the v2 gettableSilence may omit
 * (isEqual, comment, status…) are not required. Empty matchers is never a real silence.
 */
function isValidSilence(body: unknown, silenceId: string): body is AlertmanagerSilence {
  if (!isRecord(body) || body.id !== silenceId || typeof body.createdBy !== "string") return false
  const { matchers } = body
  return (
    Array.isArray(matchers) &&
    matchers.length > 0 &&
    matchers.every(
      (m) =>
        isRecord(m) &&
        typeof m.name === "string" &&
        typeof m.value === "string" &&
        (m.isRegex === undefined || typeof m.isRegex === "boolean") &&
        (m.isEqual === undefined || typeof m.isEqual === "boolean"),
    )
  )
}

export async function deleteSilence(silenceId: string): Promise<void> {
  let res: Response
  try {
    // DELETE mutates alertmanager's silence state — retry: false explicitly.
    res = await fetchWithPolicy(
      `${alertmanagerUrl()}/api/v2/silence/${encodeURIComponent(silenceId)}`,
      { method: "DELETE" },
      { retry: false }
    )
  } catch {
    throw new AlertmanagerSilenceOutcomeUnknownError()
  }
  if (res.status === 404) throw new AlertmanagerSilenceNotFoundError()
  assertSilenceWriteAccepted(res)
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
