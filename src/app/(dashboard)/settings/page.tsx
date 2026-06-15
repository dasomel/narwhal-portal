import { auth } from "@/lib/auth"
import type { UserRole } from "@/lib/auth"
import { redirect } from "next/navigation"
import { UsersTable } from "@/components/settings/users-table"
import { RoutesTable } from "@/components/settings/routes-table"
import { CertsTable } from "@/components/settings/certs-table"
import { PoliciesTable } from "@/components/settings/policies-table"
import { GroupsTable } from "@/components/settings/groups-table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"
import { SettingsPrewarmer } from "@/components/settings/settings-prewarmer"
import type { TranslationKey } from "@/lib/i18n"

const roleKey: Record<UserRole, TranslationKey> = {
  "cluster-admin": "role.cluster-admin",
  developer: "role.developer",
  viewer: "role.viewer",
  guest: "role.guest",
}

const roleBadge: Record<UserRole, string> = {
  "cluster-admin": "bg-purple-100 text-purple-700",
  developer: "bg-blue-100 text-blue-700",
  viewer: "bg-muted text-muted-foreground",
  guest: "bg-muted text-muted-foreground",
}

export default async function SettingsPage() {
  const session = await auth()
  if (session?.user?.role !== "cluster-admin") {
    redirect("/")
  }
  const locale = await getLocale()
  const name = session?.user?.name
  const email = session?.user?.email
  const role = session?.user?.role ?? "guest"
  const groups = session?.groups

  return (
    <div className="space-y-6">
      <SettingsPrewarmer />
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "settings.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "settings.description")}</p>
      </div>

      <div className="rounded-lg border bg-card p-4 flex items-center gap-4">
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-semibold text-sm shrink-0">
          {name?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground text-sm">{name ?? t(locale, "settings.unknown")}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge[role]}`}>
              {t(locale, roleKey[role])}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{email}</div>
          {groups && groups.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {groups.map((g) => (
                <span key={g} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{g}</span>
              ))}
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground shrink-0">{t(locale, "settings.currentSession")}</div>
      </div>

      <Tabs defaultValue="routes">
        <TabsList>
          <TabsTrigger value="routes">{t(locale, "settings.tabRoutes")}</TabsTrigger>
          <TabsTrigger value="users">{t(locale, "settings.tabUsers")}</TabsTrigger>
          <TabsTrigger value="groups">{t(locale, "settings.tabGroups")}</TabsTrigger>
          <TabsTrigger value="certs">{t(locale, "settings.tabCerts")}</TabsTrigger>
          <TabsTrigger value="policies">{t(locale, "settings.tabPolicies")}</TabsTrigger>
        </TabsList>
        <TabsContent value="routes" className="mt-4"><RoutesTable /></TabsContent>
        <TabsContent value="users" className="mt-4"><UsersTable /></TabsContent>
        <TabsContent value="groups" className="mt-4"><GroupsTable /></TabsContent>
        <TabsContent value="certs" className="mt-4"><CertsTable /></TabsContent>
        <TabsContent value="policies" className="mt-4"><PoliciesTable /></TabsContent>
      </Tabs>
    </div>
  )
}
