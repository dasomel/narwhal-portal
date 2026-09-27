"use client"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import { DataState } from "@/components/ui/data-state"

interface SecretEntry {
  path: string
  version: number
  createdTime: string
  updatedTime: string
}

export function SecretsTable() {
  const t = useT()
  const { data: secrets, isLoading, isError, refetch } = useQuery<SecretEntry[]>({
    queryKey: ["secrets"],
    queryFn: async () => {
      const r = await fetch("/api/secrets")
      // portal#19: a degraded/forbidden metadata read comes back as a non-2xx
      // JSON error body, not an empty array — surfacing that distinctly from
      // "no secrets exist" is the whole point of failing explicitly degraded.
      if (!r.ok) throw new Error("Failed to load secrets")
      return r.json()
    },
  })

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-4">{t("secrets.title")}</h2>
      {isLoading ? (
        <DataState state="loading" onRetry={() => { void refetch() }} />
      ) : isError ? (
        <DataState state="error" onRetry={() => { void refetch() }} />
      ) : !secrets?.length ? (
        <DataState state="empty" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("secrets.path")}</th>
              <th className="pb-2 font-medium">{t("secrets.keys")}</th>
              <th className="pb-2 font-medium">{t("secrets.version")}</th>
              <th className="pb-2 font-medium">{t("secrets.created")}</th>
              <th className="pb-2 font-medium">{t("secrets.updated")}</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.path} className="border-b last:border-0">
                <td className="py-2.5 font-mono text-xs text-foreground">{s.path}</td>
                <td className="py-2.5">
                  <Badge className="bg-muted text-muted-foreground font-mono text-xs">
                    {t("secrets.masked")}
                  </Badge>
                </td>
                <td className="py-2.5 text-muted-foreground">v{s.version}</td>
                <td className="py-2.5 text-muted-foreground text-xs">
                  {s.createdTime ? new Date(s.createdTime).toLocaleDateString() : "—"}
                </td>
                <td className="py-2.5 text-muted-foreground text-xs">
                  {s.updatedTime ? new Date(s.updatedTime).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
