import { cacheGet, cacheSet, cacheDel } from "./valkey"
import { isProduction } from "./config"

const KEYCLOAK_INTERNAL_URL =
  process.env.KEYCLOAK_INTERNAL_URL ?? "http://keycloak-service.iam.svc.cluster.local:8080"
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "narwhal"

// C-6: admin grant uses OIDC client_credentials (service account) — NOT ROPC.
// The service account behind KEYCLOAK_ADMIN_CLIENT_ID must have the
// `realm-management:realm-admin` role mapping (or the minimal subset of
// realm-management roles required by this client) for admin REST API access.
// Configure in Keycloak: Clients > <client> > Service Account Roles > assign realm-management/realm-admin.
//
// Read at call-time (not a module-level const) — mirrors getDependencyUrl's
// contract in config.ts ("call at call-time, never at module top level") so
// credential rotation via a re-mounted env/secret takes effect on the next
// token fetch without a process restart, and so it's testable per-call.
function keycloakAdminClientId(): string | undefined {
  return process.env.KEYCLOAK_ADMIN_CLIENT_ID
}
function keycloakAdminClientSecret(): string | undefined {
  return process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
}
// C-6: client_credentials uses the realm where the service-account client lives.
// Defaults to KEYCLOAK_REALM; override with KEYCLOAK_ADMIN_REALM if the SA client
// is hosted in a different realm (e.g. `master`).
function keycloakAdminRealm(): string {
  return process.env.KEYCLOAK_ADMIN_REALM ?? KEYCLOAK_REALM
}

// Portal #54: distinguishes "the admin credential itself is wrong/rejected"
// from "Keycloak is unreachable/degraded" so callers (eventually
// /api/health/status) can tell a credential-rotation problem apart from a
// provider-outage. Neither ever carries the client secret or the token —
// only an HTTP status / generic network-error message.
export class KeycloakCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeycloakCredentialError"
  }
}

export class KeycloakUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeycloakUnavailableError"
  }
}

interface CachedAdminToken {
  token: string
  expiresAt: number
}

let cachedAdminToken: CachedAdminToken | null = null
// Shared in-flight fetch so N concurrent callers on a cold/expired cache
// converge on one POST /token instead of a stampede against Keycloak —
// mirrors openbao.ts's loginInFlight.
let adminTokenInFlight: Promise<CachedAdminToken> | null = null

async function fetchAdminToken(): Promise<CachedAdminToken> {
  const clientId = keycloakAdminClientId()
  const clientSecret = keycloakAdminClientSecret()

  if (!clientId || !clientSecret) {
    // Dev-only convenience: a hand-issued admin token pasted into the env,
    // skipping the client_credentials round-trip against a local Keycloak.
    // Mirrors K8S_SA_TOKEN (k8s-token.ts) / OPENBAO_TOKEN (openbao.ts) — never
    // a valid production path, and production still fails fast below since
    // this branch is only reached when it isn't set either.
    if (!isProduction() && process.env.KEYCLOAK_ADMIN_TOKEN) {
      return { token: process.env.KEYCLOAK_ADMIN_TOKEN, expiresAt: Date.now() + 50 * 60 * 1000 }
    }
    throw new KeycloakCredentialError(
      "Keycloak admin client credentials are not configured. " +
        "Set KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET (service account with realm-management:realm-admin role)."
    )
  }

  let res: Response
  try {
    res = await fetch(
      `${KEYCLOAK_INTERNAL_URL}/realms/${keycloakAdminRealm()}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      }
    )
  } catch (err) {
    throw new KeycloakUnavailableError(`Keycloak admin token request failed: ${(err as Error).message}`)
  }

  if (!res.ok) {
    // Keycloak answers a bad client_id/client_secret with 400/401 (invalid_client);
    // a 5xx (or the network throw above) means Keycloak itself is unreachable or
    // degraded, not that the credentials are wrong.
    if (res.status >= 500) {
      throw new KeycloakUnavailableError(`Keycloak admin token request failed (HTTP ${res.status})`)
    }
    throw new KeycloakCredentialError(`Keycloak admin token request rejected (HTTP ${res.status})`)
  }

  const data = await res.json()
  const token: string | undefined = data.access_token
  if (!token) {
    throw new KeycloakCredentialError("Keycloak token response missing access_token")
  }

  const rawExpiresIn = Number(data.expires_in)
  const expiresIn = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? rawExpiresIn : 60 * 60
  // Refresh at 80% of the token lifetime — mirrors openbao.ts's Kubernetes-auth
  // login cache (getOpenBaoToken) so a short-lived admin token is re-fetched
  // well before it actually expires.
  return { token, expiresAt: Date.now() + expiresIn * 0.8 * 1000 }
}

/**
 * Resolves the Keycloak admin bearer token. Cached in-memory (per process)
 * until ~80% of its lifetime elapses; pass `forceRefresh` to bypass the cache
 * and re-fetch (used after a 401 from an admin API call).
 */
export async function getKeycloakAdminToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedAdminToken && cachedAdminToken.expiresAt > Date.now()) {
    return cachedAdminToken.token
  }

  if (!adminTokenInFlight) {
    adminTokenInFlight = fetchAdminToken().finally(() => {
      adminTokenInFlight = null
    })
  }
  cachedAdminToken = await adminTokenInFlight
  return cachedAdminToken.token
}

/**
 * Authenticated fetch against the Keycloak admin REST API. Retries once,
 * after forcing a fresh admin token, when the first attempt comes back 401 —
 * the cached token may have been revoked/rotated server-side before our
 * cache window elapsed. Callers keep interpreting the returned Response
 * (including non-401 !res.ok statuses) themselves, same as before this token
 * provider existed.
 */
async function kcFetch(url: string, init?: RequestInit): Promise<Response> {
  const doFetch = async (token: string): Promise<Response> => {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      })
    } catch (err) {
      throw new KeycloakUnavailableError(`Keycloak request failed: ${(err as Error).message}`)
    }
  }

  const token = await getKeycloakAdminToken()
  const res = await doFetch(token)
  if (res.status !== 401) return res

  const retryToken = await getKeycloakAdminToken(true)
  return doFetch(retryToken)
}

export interface KeycloakUser {
  pk: string
  username: string
  email: string
  name: string
  is_active: boolean
  last_login: string | null
  groups_obj?: Array<{ pk: string; name: string }>
}

export interface KeycloakGroup {
  pk: string
  name: string
  num_pk: number
}

export interface KeycloakGroupDetailed {
  pk: string
  name: string
  num_pk: number
  is_superuser: boolean
  parent: string | null
  parent_name: string | null
  users: string[]
  attributes: Record<string, unknown>
  roles_obj: Array<{ pk: string; name: string }>
}

function mapUser(raw: Record<string, unknown>): KeycloakUser {
  const firstName = (raw.firstName as string) ?? ""
  const lastName = (raw.lastName as string) ?? ""
  const name = [firstName, lastName].filter(Boolean).join(" ") || (raw.username as string)
  return {
    pk: raw.id as string,
    username: raw.username as string,
    email: (raw.email as string) ?? "",
    name,
    is_active: (raw.enabled as boolean) ?? true,
    last_login: null,
  }
}

// Safety limit on pagination to prevent infinite loops if the API returns repeating pages
const MAX_PAGES = 1000

async function fetchAllPages<T>(
  baseUrl: string,
  pageSize = 100,
  errorPrefix = "Keycloak API"
): Promise<T[]> {
  const results: T[] = []
  let first = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = baseUrl.includes("?") ? "&" : "?"
    const res = await kcFetch(`${baseUrl}${sep}first=${first}&max=${pageSize}`)
    if (!res.ok) throw new Error(`${errorPrefix} ${res.status}`)
    const data: T[] = await res.json()
    results.push(...data)
    if (data.length < pageSize) {
      return results
    }
    first += pageSize
  }

  throw new Error(`${errorPrefix} pagination exceeded max page limit`)
}

export async function getUsers(): Promise<KeycloakUser[]> {
  const cached = await cacheGet<KeycloakUser[]>("keycloak:users")
  if (cached) return cached

  const data = await fetchAllPages<Record<string, unknown>>(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users`,
    100,
    "Keycloak API"
  )
  const users = data.map(mapUser)
  await cacheSet("keycloak:users", users, 300)
  return users
}

export async function getGroups(): Promise<KeycloakGroup[]> {
  const cached = await cacheGet<KeycloakGroup[]>("keycloak:groups")
  if (cached) return cached

  const data = await fetchAllPages<{ id: string; name: string }>(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups`,
    100,
    "Keycloak groups"
  )
  const groups: KeycloakGroup[] = data.map((g) => ({ pk: g.id, name: g.name, num_pk: 0 }))
  await cacheSet("keycloak:groups", groups, 60)
  return groups
}

export async function getGroupsDetailed(): Promise<KeycloakGroupDetailed[]> {
  const cached = await cacheGet<KeycloakGroupDetailed[]>("keycloak:groups-detailed")
  if (cached) return cached

  const groupList = await fetchAllPages<{
    id: string
    name: string
    attributes?: Record<string, string[]>
  }>(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups`,
    100,
    "Keycloak groups"
  )

  const BATCH_SIZE = 10
  const detailed: KeycloakGroupDetailed[] = []

  for (let i = 0; i < groupList.length; i += BATCH_SIZE) {
    const batch = groupList.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (g) => {
        let members: Array<{ id: string }> = []
        try {
          members = await fetchAllPages<{ id: string }>(
            `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${g.id}/members`,
            100,
            "Get group members"
          )
        } catch {
          members = []
        }
        const rawAttrs = g.attributes ?? {}
        const attributes: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(rawAttrs)) {
          if (Array.isArray(v) && v.length === 1) {
            try {
              attributes[k] = JSON.parse(v[0])
            } catch {
              attributes[k] = v[0]
            }
          } else {
            attributes[k] = v
          }
        }
        return {
          pk: g.id,
          name: g.name,
          num_pk: 0,
          is_superuser: false,
          parent: null,
          parent_name: null,
          users: members.map((m) => m.id),
          attributes,
          roles_obj: [],
        }
      })
    )
    detailed.push(...batchResults)
  }

  await cacheSet("keycloak:groups-detailed", detailed, 60)
  return detailed
}

export async function createUser(payload: {
  username: string
  email: string
  name: string
  password: string
}): Promise<KeycloakUser> {
  const [firstName, ...rest] = payload.name.trim().split(" ")
  const lastName = rest.join(" ")

  const res = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users`,
    {
      method: "POST",
      body: JSON.stringify({
        username: payload.username,
        email: payload.email,
        firstName,
        lastName,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: "password", value: payload.password, temporary: false }],
      }),
    }
  )
  if (!res.ok) throw new Error(`Create user failed: ${await res.text()}`)

  const location = res.headers.get("Location") ?? ""
  const newId = location.split("/").pop()
  if (!newId) throw new Error("Could not parse new user ID from Location header")

  const getRes = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${newId}`
  )
  if (!getRes.ok) throw new Error(`Get new user failed: ${getRes.status}`)
  await cacheDel("keycloak:users")
  return mapUser(await getRes.json())
}

export async function setUserActive(pk: string, isActive: boolean): Promise<void> {
  const res = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${pk}`,
    {
      method: "PUT",
      body: JSON.stringify({ enabled: isActive }),
    }
  )
  if (!res.ok) throw new Error(`Update user failed: ${res.status}`)
  await cacheDel("keycloak:users")
}

export async function getGroupMembers(groupPk: string): Promise<KeycloakUser[]> {
  const data = await fetchAllPages<Record<string, unknown>>(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}/members`,
    100,
    "Get group members"
  )
  return data.map(mapUser)
}

export async function addUserToGroup(groupPk: string, userPk: string): Promise<void> {
  const res = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userPk}/groups/${groupPk}`,
    { method: "PUT" }
  )
  if (!res.ok) throw new Error(`Add user to group failed: ${res.status}`)
  await Promise.all([
    cacheDel("keycloak:groups-detailed"),
    cacheDel("keycloak:users"),
  ])
}

export async function removeUserFromGroup(groupPk: string, userPk: string): Promise<void> {
  const res = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userPk}/groups/${groupPk}`,
    { method: "DELETE" }
  )
  if (!res.ok) throw new Error(`Remove user from group failed: ${res.status}`)
  await Promise.all([
    cacheDel("keycloak:groups-detailed"),
    cacheDel("keycloak:users"),
  ])
}

export async function updateGroupAttributes(
  groupPk: string,
  attributes: Record<string, unknown>
): Promise<void> {
  const getRes = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}`
  )
  if (!getRes.ok) throw new Error(`Get group failed: ${getRes.status}`)
  const group = await getRes.json()

  // Keycloak stores attributes as Record<string, string[]>
  const kcAttributes: Record<string, string[]> = { ...(group.attributes ?? {}) }
  for (const [k, v] of Object.entries(attributes)) {
    kcAttributes[k] = [typeof v === "string" ? v : JSON.stringify(v)]
  }

  const putRes = await kcFetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}`,
    {
      method: "PUT",
      body: JSON.stringify({ ...group, attributes: kcAttributes }),
    }
  )
  if (!putRes.ok) throw new Error(`Update group attributes failed: ${putRes.status}`)
  await Promise.all([
    cacheDel("keycloak:groups"),
    cacheDel("keycloak:groups-detailed"),
  ])
}
