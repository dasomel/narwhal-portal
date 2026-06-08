import NextAuth from "next-auth"
import type { NextAuthConfig, Session } from "next-auth"
import type { JWT } from "next-auth/jwt"
import Credentials from "next-auth/providers/credentials"

// H-8: AUTH_MOCK production guard — module-load-time check
if (process.env.NODE_ENV === "production" && process.env.AUTH_MOCK === "true") {
  throw new Error("AUTH_MOCK cannot be enabled in production (NODE_ENV=production)")
}

// WO-D16 Role Mapping: UI role 'viewer' maps to OIDC group 'oidc:viewer', which binds to the Kubernetes ClusterRole 'platform-viewer'.
export type UserRole = "cluster-admin" | "developer" | "viewer" | "guest"

// C-5: RBAC role allowlist (must match nav.tsx menuItems[].roles and tools.ts PLATFORM_TOOLS[].roles)
const ALLOWED_GROUPS: ReadonlySet<UserRole> = new Set([
  "cluster-admin",
  "developer",
  "viewer",
  "guest",
])

// C-5: filter incoming group claims through the RBAC allowlist; unknown values are dropped silently.
function sanitizeGroups(input: unknown): UserRole[] {
  if (!Array.isArray(input)) return []
  const out: UserRole[] = []
  for (const g of input) {
    if (typeof g === "string" && ALLOWED_GROUPS.has(g as UserRole)) {
      out.push(g as UserRole)
    }
  }
  return out
}

// Custom team groups for my-apps/events VISIBILITY scoping — kept separate from RBAC roles.
// Any non-role group claim matching a safe identifier is preserved; role-filter.json decides
// which actually map to a scope (unmapped team groups are ignored downstream).
const TEAM_GROUP_RE = /^[a-zA-Z0-9_-]{1,64}$/
function sanitizeTeamGroups(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const g of input) {
    if (typeof g === "string" && TEAM_GROUP_RE.test(g) && !ALLOWED_GROUPS.has(g as UserRole)) {
      out.push(g)
    }
  }
  return out
}

function getRoleFromGroups(groups: UserRole[]): UserRole {
  if (groups.includes("cluster-admin")) return "cluster-admin"
  if (groups.includes("developer")) return "developer"
  if (groups.includes("viewer")) return "viewer"
  return "guest"
}

// C-5: validate iss / aud claims against environment configuration.
// Returns true if the OIDC profile passes issuer / audience checks.
function validateIssuerAudience(profile: Record<string, unknown>): boolean {
  if (process.env.AUTH_MOCK === "true") return true

  const expectedIssuer = process.env.KEYCLOAK_ISSUER
  const expectedAudience =
    process.env.KEYCLOAK_CLIENT_ID ??
    process.env.OIDC_CLIENT_ID

  if (!expectedIssuer || !expectedAudience) {
    console.error("[auth] OIDC issuer/audience env not configured", {
      hasIssuer: !!expectedIssuer,
      hasAudience: !!expectedAudience,
    })
    return false
  }

  const iss = profile.iss
  if (typeof iss !== "string" || iss !== expectedIssuer) {
    console.error("[auth] iss mismatch", { expected: expectedIssuer, got: iss })
    return false
  }

  const aud = profile.aud
  const audMatches =
    (typeof aud === "string" && aud === expectedAudience) ||
    (Array.isArray(aud) && aud.includes(expectedAudience))
  if (!audMatches) {
    console.error("[auth] aud mismatch", { expected: expectedAudience, got: aud })
    return false
  }

  return true
}

// H-11: mock provider role allowlist — dev only (production blocked by H-8 guard above).
const mockProvider = Credentials({
  id: "mock",
  name: "Mock",
  credentials: { role: { label: "Role", type: "text" } },
  authorize(credentials) {
    const raw = (credentials.role as string | undefined) ?? "developer"
    if (!ALLOWED_GROUPS.has(raw as UserRole)) {
      console.warn("[auth/mock] rejected unknown role", { role: raw })
      return null
    }
    const role = raw as UserRole
    return {
      id: "dev-user",
      name: "Dev User",
      email: "dev@narwhal.local",
      groups: [role],
    }
  },
})

const keycloakProvider = {
  id: "keycloak",
  name: "Keycloak",
  type: "oidc" as const,
  issuer: process.env.KEYCLOAK_ISSUER,
  clientId: process.env.KEYCLOAK_CLIENT_ID,
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
  authorization: { params: { scope: "openid email profile groups" } },
  profile(profile: Record<string, unknown>) {
    // C-5: enforce iss/aud and group allowlist at profile mapping time.
    if (!validateIssuerAudience(profile)) {
      throw new Error("OIDC profile failed iss/aud validation")
    }
    return {
      id: profile.sub as string,
      name: profile.name as string,
      email: profile.email as string,
      groups: sanitizeGroups(profile.groups),
    }
  },
}

export const config: NextAuthConfig = {
  providers: process.env.AUTH_MOCK === "true" ? [mockProvider] : [keycloakProvider],
  callbacks: {
    jwt({ token, profile, user, account }) {
      const p = profile as Record<string, unknown> | undefined
      const u = user as Record<string, unknown> | undefined

      // Persist the Keycloak id_token so logout can do RP-initiated (federated)
      // logout via the end_session_endpoint — otherwise the Keycloak SSO session
      // survives and the user is silently logged back in.
      if (account?.id_token) {
        token.idToken = account.id_token as string
      }

      // C-5: re-validate iss/aud on the raw OIDC profile when present (defense in depth).
      if (p && process.env.AUTH_MOCK !== "true") {
        if (!validateIssuerAudience(p)) {
          console.error("[auth/jwt] rejecting token due to iss/aud mismatch")
          return { ...token, groups: ["guest"] satisfies UserRole[] }
        }
      }

      if (p?.groups !== undefined) {
        token.groups = sanitizeGroups(p.groups)
        token.teams = sanitizeTeamGroups(p.groups)
      }
      if (u?.groups !== undefined) {
        token.groups = sanitizeGroups(u.groups)
      }
      if ((u as Record<string, unknown> | undefined)?.teams !== undefined) {
        token.teams = sanitizeTeamGroups((u as Record<string, unknown>).teams)
      }
      // C-5: ensure token.groups is always a sanitized list; default to guest.
      if (!Array.isArray(token.groups) || token.groups.length === 0) {
        token.groups = ["guest"] satisfies UserRole[]
      }
      return token
    },
    session({ session, token }: { session: Session; token: JWT }) {
      const groups = sanitizeGroups(token.groups)
      const safeGroups: UserRole[] = groups.length > 0 ? groups : ["guest"]
      session.groups = safeGroups
      session.teams = Array.isArray(token.teams) ? token.teams : []
      session.user.role = getRoleFromGroups(safeGroups)
      session.idToken = token.idToken
      return session
    },
  },
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
}

export const { handlers, auth, signIn, signOut } = NextAuth(config)

export type RoleGate = { session: Session } | { error: "unauthorized" | "forbidden" }

export async function requireRole(...roles: UserRole[]): Promise<RoleGate> {
  const session = await auth()
  if (!session) return { error: "unauthorized" }
  const role = session.user.role
  if (!role || !roles.includes(role)) return { error: "forbidden" }
  return { session }
}

export function requireAdmin(): Promise<RoleGate> {
  return requireRole("cluster-admin")
}

export function hasRole(session: Session | null | undefined, ...roles: UserRole[]): boolean {
  const role = session?.user?.role
  return !!role && roles.includes(role)
}

export function getActorId(session: Session): string {
  return session.user.email ?? session.user.name ?? "unknown"
}
