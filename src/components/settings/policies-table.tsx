"use client"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"

interface KyvernoPolicy {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  background: boolean
  validationFailureAction: string
  ready: boolean
  rulesCount: number
  rules: Array<{ name: string; type: string }>
}

export function PoliciesTable() {
  const t = useT()
  const { data: policies = [], isLoading } = useQuery<KyvernoPolicy[]>({
    queryKey: ["settings-policies"],
    queryFn: () => fetch("/api/settings/policies").then((r) => r.json()),
  })

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-4">{t("policies.title")}</h2>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : policies.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("policies.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("policies.name")}</th>
              <th className="pb-2 font-medium">{t("policies.scope")}</th>
              <th className="pb-2 font-medium">{t("policies.action")}</th>
              <th className="pb-2 font-medium">{t("policies.rules")}</th>
              <th className="pb-2 font-medium">{t("policies.status")}</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={`${p.scope}/${p.name}`} className="border-b last:border-0">
                <td className="py-2.5 font-medium">{p.name}</td>
                <td className="py-2.5">
                  <Badge className={p.scope === "cluster" ? "bg-purple-100 text-purple-700" : "bg-narwhal-accent/15 text-narwhal-accent"}>
                    {p.scope}
                  </Badge>
                </td>
                <td className="py-2.5">
                  <Badge className={p.validationFailureAction === "Enforce" ? "bg-narwhal-danger/15 text-narwhal-danger" : "bg-narwhal-warning/15 text-narwhal-warning"}>
                    {p.validationFailureAction}
                  </Badge>
                </td>
                <td className="py-2.5 text-muted-foreground">
                  {p.rulesCount} {t("policies.rulesCount")}
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {p.rules.map((r) => (
                      <span key={r.name} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                        {r.name} ({r.type})
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-2.5">
                  <Badge className={p.ready ? "bg-narwhal-success/15 text-narwhal-success" : "bg-muted text-muted-foreground"}>
                    {p.ready ? t("policies.ready") : t("policies.notReady")}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
