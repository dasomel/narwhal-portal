"use client"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n-client"

interface Route {
  id: string
  name?: string
  uri?: string
  uris?: string[]
  status: number
  plugins?: Record<string, unknown>
}

export function RoutesTable() {
  const qc = useQueryClient()
  const t = useT()
  const { data: routes = [], isLoading } = useQuery<Route[]>({
    queryKey: ["apisix-routes"],
    queryFn: () => fetch("/api/settings/routes").then((r) => r.json()),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
      fetch("/api/settings/routes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enable }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apisix-routes"] }),
  })

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-4">{t("routes.title")}</h2>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("routes.name")}</th>
              <th className="pb-2 font-medium">{t("routes.uri")}</th>
              <th className="pb-2 font-medium">{t("routes.sso")}</th>
              <th className="pb-2 font-medium">{t("routes.status")}</th>
              <th className="pb-2 font-medium">{t("routes.action")}</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="py-2.5 font-medium">{r.name ?? r.id}</td>
                <td className="py-2.5 text-muted-foreground font-mono text-xs">{r.uri ?? r.uris?.[0]}</td>
                <td className="py-2.5">
                  {r.plugins?.["openid-connect"] ? (
                    <Badge className="bg-narwhal-accent/15 text-narwhal-accent">SSO</Badge>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="py-2.5">
                  <Badge className={r.status === 1 ? "bg-narwhal-success/15 text-narwhal-success" : "bg-muted text-muted-foreground"}>
                    {r.status === 1 ? t("routes.active") : t("routes.inactive")}
                  </Badge>
                </td>
                <td className="py-2.5">
                  <Button variant="outline" size="sm"
                    onClick={() => toggleMutation.mutate({ id: r.id, enable: r.status !== 1 })}>
                    {r.status === 1 ? t("routes.deactivate") : t("routes.activate")}
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
