import { cacheGet, cacheSet, cacheDel } from "./valkey"

const KEYCLOAK_INTERNAL_URL =
  process.env.KEYCLOAK_INTERNAL_URL ?? "http://keycloak-service.iam.svc.cluster.local:8080"
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "narwhal"

// C-6: admin grant uses OIDC client_credentials (service account) — NOT ROPC.
// The service account behind KEYCLOAK_ADMIN_CLIENT_ID must have the
// `realm-management:realm-admin` role mapping (or the minimal subset of
// realm-management roles required by this client) for admin REST API access.
// Configure in Keycloak: Clients > <client> > Service Account Roles > assign realm-management/realm-admin.
const KEYCLOAK_ADMIN_CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID
const KEYCLOAK_ADMIN_CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET
// C-6: client_credentials uses the realm where the service-account client lives.
// Defaults to KEYCLOAK_REALM; override with KEYCLOAK_ADMIN_REALM if the SA client
// is hosted in a different realm (e.g. `master`).
const KEYCLOAK_ADMIN_REALM = process.env.KEYCLOAK_ADMIN_REALM ?? KEYCLOAK_REALM

function getJwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    return payload.exp ?? null
  } catch {
    return null
  }
}

async function getAdminToken(): Promise<string> {
  const cached = await cacheGet<string>("keycloak:admin-token")
  if (cached) return cached

  // C-6 / H-9: fail fast at first use if service-account credentials are missing.
  if (!KEYCLOAK_ADMIN_CLIENT_ID || !KEYCLOAK_ADMIN_CLIENT_SECRET) {
    throw new Error(
      "Keycloak admin client credentials are not configured. " +
        "Set KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET (service account with realm-management:realm-admin role)."
    )
  }

  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_ADMIN_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: KEYCLOAK_ADMIN_CLIENT_ID,
        client_secret: KEYCLOAK_ADMIN_CLIENT_SECRET,
      }),
    }
  )
  if (!res.ok) throw new Error(`Keycloak admin token failed: ${res.status}`)
  const data = await res.json()
  const token: string = data.access_token

  const exp = getJwtExpiry(token)
  let ttl = 50 * 60
  if (exp !== null) {
    const nowSec = Math.floor(Date.now() / 1000)
    ttl = Math.min(Math.max(exp - nowSec - 60, 60), 50 * 60)
  }
  await cacheSet("keycloak:admin-token", token, ttl)
  return token
}

async function headers() {
  const token = await getAdminToken()
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
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

export async function getUsers(): Promise<KeycloakUser[]> {
  const cached = await cacheGet<KeycloakUser[]>("keycloak:users")
  if (cached) return cached

  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users?max=100`,
    { headers: h }
  )
  if (!res.ok) throw new Error(`Keycloak API ${res.status}`)
  const data: Record<string, unknown>[] = await res.json()
  const users = data.map(mapUser)
  await cacheSet("keycloak:users", users, 300)
  return users
}

export async function getGroups(): Promise<KeycloakGroup[]> {
  const cached = await cacheGet<KeycloakGroup[]>("keycloak:groups")
  if (cached) return cached

  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups?max=100`,
    { headers: h }
  )
  if (!res.ok) throw new Error(`Keycloak groups ${res.status}`)
  const data: Array<{ id: string; name: string }> = await res.json()
  const groups: KeycloakGroup[] = data.map((g) => ({ pk: g.id, name: g.name, num_pk: 0 }))
  await cacheSet("keycloak:groups", groups, 60)
  return groups
}

export async function getGroupsDetailed(): Promise<KeycloakGroupDetailed[]> {
  const cached = await cacheGet<KeycloakGroupDetailed[]>("keycloak:groups-detailed")
  if (cached) return cached

  const h = await headers()
  const listRes = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups?max=100`,
    { headers: h }
  )
  if (!listRes.ok) throw new Error(`Keycloak groups ${listRes.status}`)
  const groupList: Array<{ id: string; name: string; attributes?: Record<string, string[]> }> =
    await listRes.json()

  const detailed = await Promise.all(
    groupList.map(async (g) => {
      const membersRes = await fetch(
        `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${g.id}/members?max=100`,
        { headers: h }
      )
      const members: Record<string, unknown>[] = membersRes.ok ? await membersRes.json() : []
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
      const detailed: KeycloakGroupDetailed = {
        pk: g.id,
        name: g.name,
        num_pk: 0,
        is_superuser: false,
        parent: null,
        parent_name: null,
        users: members.map((m) => m.id as string),
        attributes,
        roles_obj: [],
      }
      return detailed
    })
  )

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

  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users`,
    {
      method: "POST",
      headers: h,
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

  const getRes = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${newId}`,
    { headers: h }
  )
  if (!getRes.ok) throw new Error(`Get new user failed: ${getRes.status}`)
  return mapUser(await getRes.json())
}

export async function setUserActive(pk: string, isActive: boolean): Promise<void> {
  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${pk}`,
    {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ enabled: isActive }),
    }
  )
  if (!res.ok) throw new Error(`Update user failed: ${res.status}`)
}

export async function getGroupMembers(groupPk: string): Promise<KeycloakUser[]> {
  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}/members?max=100`,
    { headers: h }
  )
  if (!res.ok) throw new Error(`Get group members ${res.status}`)
  const data: Record<string, unknown>[] = await res.json()
  return data.map(mapUser)
}

export async function addUserToGroup(groupPk: string, userPk: string): Promise<void> {
  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userPk}/groups/${groupPk}`,
    { method: "PUT", headers: h }
  )
  if (!res.ok) throw new Error(`Add user to group failed: ${res.status}`)
  await cacheDel("keycloak:groups-detailed")
}

export async function removeUserFromGroup(groupPk: string, userPk: string): Promise<void> {
  const h = await headers()
  const res = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userPk}/groups/${groupPk}`,
    { method: "DELETE", headers: h }
  )
  if (!res.ok) throw new Error(`Remove user from group failed: ${res.status}`)
  await cacheDel("keycloak:groups-detailed")
}

export async function updateGroupAttributes(
  groupPk: string,
  attributes: Record<string, unknown>
): Promise<void> {
  const h = await headers()
  const getRes = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}`,
    { headers: h }
  )
  if (!getRes.ok) throw new Error(`Get group failed: ${getRes.status}`)
  const group = await getRes.json()

  // Keycloak stores attributes as Record<string, string[]>
  const kcAttributes: Record<string, string[]> = { ...(group.attributes ?? {}) }
  for (const [k, v] of Object.entries(attributes)) {
    kcAttributes[k] = [typeof v === "string" ? v : JSON.stringify(v)]
  }

  const putRes = await fetch(
    `${KEYCLOAK_INTERNAL_URL}/admin/realms/${KEYCLOAK_REALM}/groups/${groupPk}`,
    {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ ...group, attributes: kcAttributes }),
    }
  )
  if (!putRes.ok) throw new Error(`Update group attributes failed: ${putRes.status}`)
  await cacheDel("keycloak:groups-detailed")
}
