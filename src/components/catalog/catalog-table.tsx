"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { useState } from "react"
import { useT } from "@/lib/i18n-client"
import type { CatalogService } from "@/lib/argocd"

const syncColors: Record<string, string> = {
  Synced: "bg-narwhal-success/15 text-narwhal-success",
  OutOfSync: "bg-narwhal-warning/15 text-narwhal-warning",
  Unknown: "bg-muted text-muted-foreground",
}

const healthColors: Record<string, string> = {
  Healthy: "bg-narwhal-success/15 text-narwhal-success",
  Degraded: "bg-narwhal-danger/15 text-narwhal-danger",
  Progressing: "bg-narwhal-accent/15 text-narwhal-accent",
  Suspended: "bg-muted text-muted-foreground",
  Missing: "bg-narwhal-warning/15 text-narwhal-warning",
  Unknown: "bg-muted text-muted-foreground",
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "-"
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function CatalogTable() {
  const t = useT()
  const [search, setSearch] = useState("")

  const { data: services, isLoading } = useQuery<CatalogService[]>({
    queryKey: ["catalog"],
    queryFn: () => fetch("/api/catalog").then((r) => r.json()),
    refetchInterval: 15_000,
  })

  const filtered = (services ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.namespace.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t("catalog.title")}</CardTitle>
          <Input
            placeholder={t("catalog.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-60 h-8 text-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("catalog.total", { count: filtered.length })}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t("catalog.name")}</TableHead>
                <TableHead>{t("catalog.namespace")}</TableHead>
                <TableHead>{t("catalog.sync")}</TableHead>
                <TableHead>{t("catalog.health")}</TableHead>
                <TableHead>{t("catalog.revision")}</TableHead>
                <TableHead>{t("catalog.resources")}</TableHead>
                <TableHead>{t("catalog.lastDeploy")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((svc) => (
                <TableRow key={svc.name} className="hover:bg-muted/50">
                  <TableCell className="pl-6 font-medium">
                    <Link
                      href={`/catalog/${svc.name}`}
                      className="text-blue-600 hover:underline"
                    >
                      {svc.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{svc.namespace}</TableCell>
                  <TableCell>
                    <Badge className={`text-xs ${syncColors[svc.syncStatus] ?? syncColors.Unknown}`}>
                      {svc.syncStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={`text-xs ${healthColors[svc.healthStatus] ?? healthColors.Unknown}`}>
                      {svc.healthStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{svc.revision}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{svc.resourceCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(svc.lastDeployed)}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                    {t("catalog.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
