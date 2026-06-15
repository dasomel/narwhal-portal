"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useT } from "@/lib/i18n-client"
import type { ArgoApp } from "@/lib/argocd"
import { PodLogsViewer } from "./pod-logs-viewer"
import { ServiceQualityTab } from "./service-quality-tab"
import { ServiceDependenciesTab } from "./service-dependencies-tab"
import { ServiceCostTab } from "./service-cost-tab"

interface DetailResponse {
  app: ArgoApp
  alerts: Array<{
    labels: Record<string, string>
    annotations: Record<string, string>
    startsAt: string
  }>
}

const healthColors: Record<string, string> = {
  Healthy: "bg-narwhal-success/15 text-narwhal-success",
  Degraded: "bg-narwhal-danger/15 text-narwhal-danger",
  Progressing: "bg-narwhal-accent/15 text-narwhal-accent",
  Suspended: "bg-muted text-muted-foreground",
  Missing: "bg-narwhal-warning/15 text-narwhal-warning",
}

type Tab = "overview" | "quality" | "dependencies" | "cost" | "logs"

const TAB_KEYS: Record<Tab, "catalog.tab.overview" | "catalog.tab.quality" | "catalog.tab.dependencies" | "catalog.tab.cost" | "catalog.tab.logs"> = {
  overview: "catalog.tab.overview",
  quality: "catalog.tab.quality",
  dependencies: "catalog.tab.dependencies",
  cost: "catalog.tab.cost",
  logs: "catalog.tab.logs",
}

export function ServiceDetail() {
  const t = useT()
  const { name } = useParams<{ name: string }>()
  const [activeTab, setActiveTab] = useState<Tab>("overview")

  const { data, isLoading, error } = useQuery<DetailResponse>({
    queryKey: ["catalog", name],
    queryFn: () => fetch(`/api/catalog/${name}`).then((r) => {
      if (!r.ok) throw new Error("Not found")
      return r.json()
    }),
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">{t("common.loading")}</div>
  }

  if (error || !data) {
    return (
      <Card className="p-8 text-center">
        <p className="text-muted-foreground">{t("catalog.notFound")}</p>
        <Link href="/catalog" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          {t("catalog.backToList")}
        </Link>
      </Card>
    )
  }

  const { app, alerts } = data
  const history = [...(app.status.history ?? [])].reverse().slice(0, 10)

  const appNamespace = app.spec.destination?.namespace ?? ""

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/catalog" className="text-muted-foreground hover:text-muted-foreground text-sm">&larr;</Link>
        <h2 className="text-xl font-bold text-foreground">{app.metadata.name}</h2>
        <Badge className={`text-xs ${healthColors[app.status.health.status] ?? "bg-muted text-muted-foreground"}`}>
          {app.status.health.status}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {app.status.sync.status}
        </Badge>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["overview", "quality", "dependencies", "cost", "logs"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(TAB_KEYS[tab])}
          </button>
        ))}
      </div>

      {activeTab === "quality" && <ServiceQualityTab serviceName={app.metadata.name} />}
      {activeTab === "dependencies" && <ServiceDependenciesTab serviceName={app.metadata.name} />}
      {activeTab === "cost" && <ServiceCostTab serviceId={app.metadata.name} />}

      {activeTab === "logs" && appNamespace && (
        <PodLogsViewer namespace={appNamespace} appName={app.metadata.name} />
      )}

      {activeTab === "overview" && <div className="space-y-4">
      {/* Info cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">{t("catalog.namespace")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <span className="text-sm font-medium">{app.spec.destination?.namespace ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">{t("catalog.revision")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <span className="text-sm font-mono">{app.status.sync.revision?.slice(0, 12) ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground font-normal">{t("catalog.resources")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <span className="text-sm font-medium">{app.status.resources?.length ?? 0}</span>
          </CardContent>
        </Card>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <Card className="border-red-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-red-700">{t("catalog.relatedAlerts")} ({alerts.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <Badge className="bg-narwhal-danger/15 text-narwhal-danger text-xs shrink-0">{a.labels.severity ?? "warning"}</Badge>
                <span className="text-muted-foreground">{a.annotations.summary ?? a.labels.alertname}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Resources */}
      {app.status.resources && app.status.resources.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("catalog.resourceList")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t("catalog.resKind")}</TableHead>
                  <TableHead>{t("catalog.resName")}</TableHead>
                  <TableHead>{t("catalog.health")}</TableHead>
                  <TableHead>{t("catalog.resStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {app.status.resources.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="pl-6 text-xs font-mono">{r.kind}</TableCell>
                    <TableCell className="text-xs">{r.name}</TableCell>
                    <TableCell>
                      {r.health?.status && (
                        <Badge className={`text-xs ${healthColors[r.health.status] ?? "bg-muted"}`}>
                          {r.health.status}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.status ?? "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Deploy History */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("catalog.history")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {history.map((h) => (
              <div key={h.id} className="flex items-center gap-3 text-xs">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="font-mono text-muted-foreground">{h.revision?.slice(0, 7)}</span>
                <span className="text-muted-foreground">{new Date(h.deployedAt).toLocaleString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      </div>}
    </div>
  )
}
