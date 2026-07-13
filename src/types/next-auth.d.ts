import type { DefaultSession } from "next-auth"
import type { UserRole } from "@/lib/auth"

declare module "next-auth" {
  interface Session {
    groups: string[]
    teams?: string[]
    idToken?: string
    error?: string
    user: DefaultSession["user"] & { role: UserRole }
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    groups?: string[]
    teams?: string[]
    idToken?: string
    // Keycloak SSO-session keep-alive: the refresh token + access-token expiry are
    // persisted so the portal can refresh before expiry, which counts as session
    // activity and resets Keycloak's ssoSessionIdleTimeout (keeps linked apps zero-click).
    refreshToken?: string
    accessToken?: string
    expiresAt?: number
    error?: string
  }
}
