"use client"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import { ResourceDetailDrawer } from "./resource-detail-drawer"
import type { ResourcesResponseV2, NamespaceUsageV2 } from "./types"

const toGiB = (bytes: number) => (bytes / (1024 * 1024 * 1024)).toFixed(2)

const formatBytes = (bytes: number) => {
  const mib = bytes / (1024 * 1024)
  if (mib >= 1024) {
    return `${(mib / 1024).toFixed(2)} GiB`
  }
  return `${mib.toFixed(1)} MiB`
}

export function ResourceChart() {
  const t = useT()
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null)
  const [selectedPodName, setSelectedPodName] = useState<string | undefined>(undefined)

  const { data, isLoading } = useQuery<ResourcesResponseV2>({
    queryKey: ["governance-resources"],
    queryFn: () => fetch("/api/governance/resources").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const namespaces = data?.namespaces ?? []
  const topCpuPods = data?.topCpuPods ?? []
  const topMemPods = data?.topMemPods ?? []
  const cluster = data?.cluster ?? { cpuPercent: 0, memPercent: 0, totalPods: 0, noRequestPods: 0 }

  const handleChartClick = (state: any) => {
    if (state && state.activeLabel && state.activePayload && state.activePayload.length > 0) {
      setSelectedNamespace(state.activeLabel)
      setSelectedPodName(undefined)
    }
  }

  const handlePodClick = (namespace: string, podName: string) => {
    setSelectedNamespace(namespace)
    setSelectedPodName(podName)
  }

  const hasNoRequestPods = cluster.noRequestPods > 0
  const noRequestCardBg = hasNoRequestPods
    ? "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900"
    : "bg-card border-border"
  const noRequestTextColor = hasNoRequestPods
    ? "text-amber-500 dark:text-amber-400"
    : "text-foreground"

  const statCards = [
    {
      label: t("resources.stat.cpuUsage"),
      value: `${cluster.cpuPercent.toFixed(1)}%`,
      color: "text-indigo-600 dark:text-indigo-400",
      bg: "bg-indigo-50/50 border-indigo-150/40 dark:bg-indigo-950/20 dark:border-indigo-900/40"
    },
    {
      label: t("resources.stat.memUsage"),
      value: `${cluster.memPercent.toFixed(1)}%`,
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-50/50 border-emerald-150/40 dark:bg-emerald-950/20 dark:border-emerald-900/40"
    },
    {
      label: t("resources.stat.totalPods"),
      value: cluster.totalPods,
      color: "text-foreground",
      bg: "bg-card border-border"
    },
    {
      label: t("resources.stat.noRequestPods"),
      value: cluster.noRequestPods,
      color: noRequestTextColor,
      bg: noRequestCardBg,
      caption: hasNoRequestPods ? t("resources.stat.noRequestPodsCaption") : undefined
    }
  ]

  return (
    <div className="space-y-4">
      {/* 4 Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((card, idx) => (
          <div key={idx} className={`rounded-lg border p-4 flex flex-col justify-between ${card.bg}`}>
            <div>
              <div className="text-xs font-medium text-muted-foreground">{card.label}</div>
              <div className={`text-2xl font-bold mt-1.5 ${card.color}`}>{card.value}</div>
            </div>
            {card.caption && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-2 font-medium">
                {card.caption}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Namespace Bar Chart Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-foreground">{t("resources.title")}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : namespaces.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">
              {t("resources.empty")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={namespaces}
                margin={{ top: 4, right: 16, left: -10, bottom: 60 }}
                onClick={handleChartClick}
                style={{ cursor: "pointer" }}
              >
                <XAxis
                  dataKey="namespace"
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  angle={-35}
                  textAnchor="end"
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      const nsData = payload[0].payload as NamespaceUsageV2
                      const cpuPercent = nsData.cpuPercent.toFixed(1)
                      const memPercent = nsData.memoryPercent.toFixed(1)
                      const cpuUsed = nsData.cpuUsedCores.toFixed(3)
                      const cpuReq = nsData.cpuRequestedCores.toFixed(3)
                      const memUsed = toGiB(nsData.memUsedBytes)
                      const memReq = toGiB(nsData.memRequestedBytes)

                      return (
                        <div className="bg-popover text-popover-foreground p-3 border rounded-lg shadow-sm space-y-2">
                          <div className="font-semibold text-xs border-b pb-1">{label}</div>
                          <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-4 justify-between">
                              <span className="flex items-center gap-1.5 font-medium">
                                <span className="w-2 h-2 rounded-full bg-[#6366f1]" />
                                {t("resources.cpu")}
                              </span>
                              <span className="font-semibold">{cpuPercent}%</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground pl-3.5">
                              {cpuUsed} / {cpuReq} cores
                            </div>

                            <div className="flex items-center gap-4 justify-between mt-1.5">
                              <span className="flex items-center gap-1.5 font-medium">
                                <span className="w-2 h-2 rounded-full bg-[#10b981]" />
                                {t("resources.memory")}
                              </span>
                              <span className="font-semibold">{memPercent}%</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground pl-3.5">
                              {memUsed} / {memReq} GiB
                            </div>

                            <div className="text-[10px] text-muted-foreground border-t pt-1.5 mt-1.5">
                              Pods: {nsData.podCount} (unconfigured: {nsData.noRequestPods})
                            </div>
                          </div>
                        </div>
                      )
                    }
                    return null
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Bar dataKey="cpuPercent" name={t("resources.cpu")} fill="#6366f1" radius={[3, 3, 0, 0]} cursor="pointer" />
                <Bar dataKey="memoryPercent" name={t("resources.memory")} fill="#10b981" radius={[3, 3, 0, 0]} cursor="pointer" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top 10 CPU / Memory Tables Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top 10 CPU Table */}
        <Card className="p-4 border">
          <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#6366f1]" />
            {t("resources.topCpuTitle")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b text-muted-foreground pb-2">
                  <th className="pb-2">{t("resources.table.namespace")}</th>
                  <th className="pb-2">{t("resources.table.pod")}</th>
                  <th className="pb-2 text-right">{t("resources.table.usage")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-muted-foreground animate-pulse">
                      {t("common.loading")}
                    </td>
                  </tr>
                ) : topCpuPods.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-muted-foreground italic">
                      {t("common.notFound")}
                    </td>
                  </tr>
                ) : (
                  topCpuPods.map((pod, idx) => (
                    <tr
                      key={idx}
                      className="border-b last:border-0 hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => handlePodClick(pod.namespace, pod.pod)}
                    >
                      <td className="py-2 pr-2 font-medium max-w-[120px] truncate" title={pod.namespace}>{pod.namespace}</td>
                      <td className="py-2 pr-2 font-mono text-[11px] truncate max-w-[180px]" title={pod.pod}>{pod.pod}</td>
                      <td className="py-2 text-right font-mono text-[11px] font-semibold text-foreground">
                        {pod.cpuCores.toFixed(3)} cores
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Top 10 Memory Table */}
        <Card className="p-4 border">
          <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#10b981]" />
            {t("resources.topMemTitle")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b text-muted-foreground pb-2">
                  <th className="pb-2">{t("resources.table.namespace")}</th>
                  <th className="pb-2">{t("resources.table.pod")}</th>
                  <th className="pb-2 text-right">{t("resources.table.usage")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-muted-foreground animate-pulse">
                      {t("common.loading")}
                    </td>
                  </tr>
                ) : topMemPods.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-muted-foreground italic">
                      {t("common.notFound")}
                    </td>
                  </tr>
                ) : (
                  topMemPods.map((pod, idx) => (
                    <tr
                      key={idx}
                      className="border-b last:border-0 hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => handlePodClick(pod.namespace, pod.pod)}
                    >
                      <td className="py-2 pr-2 font-medium max-w-[120px] truncate" title={pod.namespace}>{pod.namespace}</td>
                      <td className="py-2 pr-2 font-mono text-[11px] truncate max-w-[180px]" title={pod.pod}>{pod.pod}</td>
                      <td className="py-2 text-right font-mono text-[11px] font-semibold text-foreground">
                        {formatBytes(pod.memBytes)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <ResourceDetailDrawer
        namespace={selectedNamespace ?? ""}
        open={!!selectedNamespace}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedNamespace(null)
            setSelectedPodName(undefined)
          }
        }}
        initialPodName={selectedPodName}
      />
    </div>
  )
}
