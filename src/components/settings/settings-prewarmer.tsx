"use client"
import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"

export function SettingsPrewarmer() {
  // Pre-warm the cache for all settings tabs so switching is instant
  const usersQuery = useQuery({
    queryKey: ["settings-users"],
    queryFn: () => fetch("/api/settings/users").then((r) => r.json()),
    staleTime: 60_000,
  })

  const groupsQuery = useQuery({
    queryKey: ["settings-groups"],
    queryFn: () => fetch("/api/settings/groups").then((r) => r.json()),
    staleTime: 60_000,
  })

  const routesQuery = useQuery({
    queryKey: ["apisix-routes"],
    queryFn: () => fetch("/api/settings/routes").then((r) => r.json()),
    staleTime: 60_000,
  })

  // We don't render anything, just trigger background fetches
  return null
}
