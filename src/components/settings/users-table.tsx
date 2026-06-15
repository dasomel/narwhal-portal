"use client"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT, useLocale } from "@/lib/i18n-client"

interface UserGroup {
  pk: string
  name: string
}

interface User {
  pk: number
  username: string
  email: string
  name: string
  is_active: boolean
  last_login: string | null
  groups_obj?: UserGroup[]
}

const groupColors: Record<string, string> = {
  "cluster-admin": "bg-narwhal-danger/15 text-narwhal-danger",
  "keycloak Admins": "bg-purple-100 text-purple-700",
  developer: "bg-narwhal-accent/15 text-narwhal-accent",
  viewer: "bg-muted text-muted-foreground",
  guest: "bg-narwhal-warning/15 text-narwhal-warning",
}

export function UsersTable() {
  const [search, setSearch] = useState("")
  const qc = useQueryClient()
  const t = useT()
  const locale = useLocale()
  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["settings-users"],
    queryFn: () => fetch("/api/settings/users").then((r) => r.json()),
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ pk, isActive }: { pk: number; isActive: boolean }) => {
      await fetch(`/api/settings/users/${pk}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings-users"] }),
  })

  const filtered = users.filter(
    (u) => u.username.includes(search) || u.email.includes(search)
  )

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-foreground">{t("users.title")}</h2>
        <Input
          placeholder={t("users.searchPlaceholder")}
          className="w-48"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("users.username")}</th>
              <th className="pb-2 font-medium">{t("users.email")}</th>
              <th className="pb-2 font-medium">{t("users.groups")}</th>
              <th className="pb-2 font-medium">{t("users.lastLogin")}</th>
              <th className="pb-2 font-medium">{t("users.status")}</th>
              <th className="pb-2 font-medium">{t("users.action")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => (
              <tr key={user.pk} className="border-b last:border-0">
                <td className="py-2.5 font-medium">{user.username}</td>
                <td className="py-2.5 text-muted-foreground">{user.email}</td>
                <td className="py-2.5">
                  <div className="flex gap-1 flex-wrap">
                    {user.groups_obj && user.groups_obj.length > 0 ? (
                      user.groups_obj.map((g) => (
                        <Badge key={g.pk} className={groupColors[g.name] ?? "bg-muted text-muted-foreground"}>
                          {g.name}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 text-muted-foreground text-xs">
                  {user.last_login ? new Date(user.last_login).toLocaleString(locale === "ko" ? "ko-KR" : "en-US") : t("users.never")}
                </td>
                <td className="py-2.5">
                  <Badge className={user.is_active ? "bg-narwhal-success/15 text-narwhal-success" : "bg-muted text-muted-foreground"}>
                    {user.is_active ? t("users.active") : t("users.inactive")}
                  </Badge>
                </td>
                <td className="py-2.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleMutation.mutate({ pk: user.pk, isActive: !user.is_active })}
                  >
                    {user.is_active ? t("users.deactivate") : t("users.activate")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
