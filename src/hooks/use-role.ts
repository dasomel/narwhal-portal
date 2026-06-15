"use client"

import { useSession } from "next-auth/react"

export type Role = "cluster-admin" | "developer" | "viewer" | "guest"

type PrivilegedAction = "silence" | "sync" | "rollback" | "cordon" | "drain"

const ACTION_ROLES: Record<PrivilegedAction, Role[]> = {
  silence: ["cluster-admin", "developer"],
  sync: ["cluster-admin", "developer"],
  rollback: ["cluster-admin", "developer"],
  cordon: ["cluster-admin"],
  drain: ["cluster-admin"],
}

export function useRole(): { role: Role; can: (action: PrivilegedAction) => boolean } {
  const { data: session } = useSession()
  const role = ((session?.user as { role?: string })?.role ?? "guest") as Role

  function can(action: PrivilegedAction): boolean {
    return ACTION_ROLES[action].includes(role)
  }

  return { role, can }
}
