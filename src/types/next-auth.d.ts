import type { DefaultSession } from "next-auth"
import type { UserRole } from "@/lib/auth"

declare module "next-auth" {
  interface Session {
    groups: string[]
    teams?: string[]
    idToken?: string
    user: DefaultSession["user"] & { role: UserRole }
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    groups?: string[]
    teams?: string[]
    idToken?: string
  }
}
