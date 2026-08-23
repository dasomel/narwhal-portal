import type { DefaultSession } from "next-auth"
import type { GroupClaimStatus, UserRole } from "@/lib/auth"

declare module "next-auth" {
  interface Session {
    groups: string[]
    teams?: string[]
    // narwhal#163: distinguishes a legitimate no-groups guest from one whose raw
    // groups claim was present but entirely rejected by the RBAC allowlist.
    groupClaimStatus?: GroupClaimStatus
    idToken?: string
    error?: string
    user: DefaultSession["user"] & { role: UserRole }
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    groups?: string[]
    teams?: string[]
    groupClaimStatus?: GroupClaimStatus
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
