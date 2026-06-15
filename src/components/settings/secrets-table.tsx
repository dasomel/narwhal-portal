"use client"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"

interface SecretEntry {
  path: string
  keys: string[]
  version: number
  createdTime: string
}

export function SecretsTable() {
  const t = useT()
  const { data: secrets = [], isLoading } = useQuery<SecretEntry[]>({
    queryKey: ["secrets"],
    queryFn: () => fetch("/api/secrets").then((r) => r.json()).then((d) => Array.isArray(d) ? d : []),
  })

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-4">{t("secrets.title")}</h2>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("secrets.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("secrets.path")}</th>
              <th className="pb-2 font-medium">{t("secrets.keys")}</th>
              <th className="pb-2 font-medium">{t("secrets.version")}</th>
              <th className="pb-2 font-medium">{t("secrets.created")}</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.path} className="border-b last:border-0">
                <td className="py-2.5 font-mono text-xs text-foreground">{s.path}</td>
                <td className="py-2.5">
                  <Badge className="bg-muted text-muted-foreground font-mono text-xs">
                    {t("secrets.masked", { count: s.keys.length })}
                  </Badge>
                </td>
                <td className="py-2.5 text-muted-foreground">v{s.version}</td>
                <td className="py-2.5 text-muted-foreground text-xs">
                  {s.createdTime ? new Date(s.createdTime).toLocaleDateString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
