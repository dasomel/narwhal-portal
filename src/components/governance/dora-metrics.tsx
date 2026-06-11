"use client"

import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useT } from "@/lib/i18n-client"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"
import type { DoraMetrics } from "./types"

function relativeTime(ts: string, tFn: any): string {
  if (!ts) return "—"
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return tFn("audit.justNow") || "방금"
  if (mins < 60) return tFn("audit.minsAgo", { mins }) || `${mins}m 전`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tFn("audit.hrsAgo", { hrs }) || `${hrs}h 전`
  return tFn("audit.daysAgo", { days: Math.floor(hrs / 24) }) || `${Math.floor(hrs / 24)}d 전`
}

function StatCard({
  title,
  value,
  unit,
  desc,
  status,
}: {
  title: string
  value: string
  unit: string
  desc: string
  status: "success" | "warning" | "danger" | "normal"
}) {
  const valueColor =
    status === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "warning"
      ? "text-amber-500 dark:text-amber-400"
      : status === "danger"
      ? "text-rose-600 dark:text-rose-400"
      : "text-foreground"

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-semibold text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <div className="flex items-baseline gap-1">
          <span className={`text-2xl font-bold tracking-tight ${valueColor}`}>{value}</span>
          {unit && <span className="text-xs font-medium text-muted-foreground">{unit}</span>}
        </div>
        <p className="text-[10px] leading-normal text-muted-foreground/80">{desc}</p>
      </CardContent>
    </Card>
  )
}

function DoraSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card border rounded-xl p-5 space-y-3">
            <div className="h-3 w-24 bg-muted animate-pulse rounded-md" />
            <div className="h-8 w-16 bg-muted animate-pulse rounded-md" />
            <div className="h-3 w-36 bg-muted animate-pulse rounded-md" />
          </div>
        ))}
      </div>

      <div className="bg-card border rounded-xl p-5 space-y-4">
        <div className="h-4 w-32 bg-muted animate-pulse rounded-md" />
        <div className="h-56 bg-muted/30 animate-pulse rounded-md" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="bg-card border rounded-xl p-5 space-y-4">
            <div className="h-4 w-36 bg-muted animate-pulse rounded-md" />
            <div className="space-y-2">
              {[...Array(5)].map((_, j) => (
                <div key={j} className="h-8 bg-muted animate-pulse rounded-md" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function DoraMetricsWidget() {
  const t = useT()

  const { data, isLoading, isError } = useQuery<DoraMetrics>({
    queryKey: ["governance-dora"],
    queryFn: () =>
      fetch("/api/governance/dora").then((r) => {
        if (!r.ok) throw new Error("Failed to fetch DORA metrics")
        return r.json()
      }),
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return <DoraSkeleton />
  }

  if (isError || !data) {
    return (
      <Card className="p-6">
        <div className="h-24 flex items-center justify-center text-sm text-rose-500 font-medium">
          {t("common.loadError")}
        </div>
      </Card>
    )
  }

  // Determine statuses for DORA metrics based on industry benchmarks
  // Deploy Frequency: Elite/High >= 1 per day
  const freqStatus = data.deployFrequency >= 1 ? "success" : data.deployFrequency >= 0.14 ? "warning" : "danger"
  
  // Lead Time: Elite/High <= 24 hours
  const leadStatus =
    data.leadTimeHours === null
      ? "normal"
      : data.leadTimeHours <= 24
      ? "success"
      : data.leadTimeHours <= 168
      ? "warning"
      : "danger"

  // Failure Rate: Elite/High/Medium <= 15%
  const failStatus = data.changeFailureRate <= 15 ? "success" : "danger"

  // MTTR: Elite/High <= 60 minutes
  const mttrStatus =
    data.mttrMinutes === null
      ? "normal"
      : data.mttrMinutes <= 60
      ? "success"
      : data.mttrMinutes <= 1440
      ? "warning"
      : "danger"

  const hasData = data.totalDeploys > 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground text-base">{t("dora.title")}</h2>
        <span className="text-xs text-muted-foreground">{t("dora.period")}</span>
      </div>

      {/* 4 Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title={t("dora.deployFrequency")}
          value={data.deployFrequency.toFixed(2)}
          unit={t("dora.deployFrequencyUnit")}
          desc={t("dora.deployFrequencyDesc")}
          status={freqStatus}
        />
        <StatCard
          title={t("dora.leadTime")}
          value={data.leadTimeHours !== null ? data.leadTimeHours.toFixed(1) : "—"}
          unit={data.leadTimeHours !== null ? t("dora.leadTimeUnit") : ""}
          desc={t("dora.leadTimeDesc")}
          status={leadStatus}
        />
        <StatCard
          title={t("dora.failureRate")}
          value={`${data.changeFailureRate.toFixed(1)}`}
          unit="%"
          desc={t("dora.failureRateDesc")}
          status={failStatus}
        />
        <StatCard
          title={t("dora.mttr")}
          value={data.mttrMinutes !== null ? Math.round(data.mttrMinutes).toString() : "—"}
          unit={data.mttrMinutes !== null ? t("dora.mttrUnit") : ""}
          desc={t("dora.mttrDesc")}
          status={mttrStatus}
        />
      </div>

      {!hasData ? (
        <Card className="p-6">
          <div className="h-48 border border-dashed rounded-xl flex flex-col items-center justify-center bg-card p-6">
            <span className="text-sm font-semibold text-muted-foreground">{t("dora.emptyDeploys")}</span>
          </div>
        </Card>
      ) : (
        <>
          {/* Trend Chart */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-foreground">{t("dora.trendTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.dailyDeploys} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                    formatter={(value) => [`${value} ${t("dora.totalDeploysUnit") || ""}`]}
                  />
                  <Bar dataKey="count" name={t("dora.totalDeploys")} fill="#6366f1" radius={[3, 3, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Bottom Grid: Per-App Table & Recent Deployments */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Per-App Table */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold text-foreground">{t("dora.perAppTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="py-2 text-xs">{t("dora.colApp")}</TableHead>
                      <TableHead className="py-2 text-xs">{t("dora.colNamespace")}</TableHead>
                      <TableHead className="py-2 text-xs text-center w-16">{t("dora.colDeploys")}</TableHead>
                      <TableHead className="py-2 text-xs text-right w-24">{t("dora.colLeadTime")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.perApp.map((appItem) => (
                      <TableRow key={`${appItem.namespace}-${appItem.app}`} className="hover:bg-muted/10">
                        <TableCell className="py-2 text-xs font-semibold">{appItem.app}</TableCell>
                        <TableCell className="py-2 text-xs text-muted-foreground font-mono">{appItem.namespace}</TableCell>
                        <TableCell className="py-2 text-center text-xs tabular-nums font-medium">{appItem.deploys}</TableCell>
                        <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {appItem.leadTimeHours !== null ? `${appItem.leadTimeHours.toFixed(1)}h` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Recent Deployments */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold text-foreground">{t("dora.recentTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="py-2 text-xs">{t("dora.colApp")}</TableHead>
                      <TableHead className="py-2 text-xs w-20">{t("dora.colRevision")}</TableHead>
                      <TableHead className="py-2 text-xs text-right w-28">{t("dora.colTime")}</TableHead>
                      <TableHead className="py-2 text-xs text-right w-24">{t("dora.colStatus")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recent.map((deploy, index) => (
                      <TableRow key={index} className="hover:bg-muted/10">
                        <TableCell className="py-2 text-xs font-semibold">{deploy.app}</TableCell>
                        <TableCell className="py-2 text-xs">
                          <code className="font-mono text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
                            {deploy.revision.slice(0, 7)}
                          </code>
                        </TableCell>
                        <TableCell className="py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                          {relativeTime(deploy.deployedAt, t)}
                        </TableCell>
                        <TableCell className="py-2 text-right text-xs">
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-semibold px-2 py-0.5 ${
                              deploy.status === "Succeeded"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/45 dark:text-emerald-400 dark:border-emerald-800/40"
                                : "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/45 dark:text-rose-400 dark:border-rose-800/40"
                            }`}
                          >
                            {deploy.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
