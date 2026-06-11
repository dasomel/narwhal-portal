"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useT } from "@/lib/i18n-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { DistributionResponse } from "./types"

const severityBadgeClass = {
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
}

export function DistributionView() {
  const t = useT()

  const { data, isLoading, error } = useQuery<DistributionResponse>({
    queryKey: ["governance-distribution"],
    queryFn: () => fetch("/api/governance/distribution").then((r) => {
      if (!r.ok) throw new Error("Failed to fetch distribution data")
      return r.json()
    }),
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="h-64 flex items-center justify-center text-xs text-muted-foreground animate-pulse">
        {t("common.loading")}
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="h-64 flex items-center justify-center text-xs text-red-500 font-medium">
        Failed to load workload distribution details.
      </div>
    )
  }

  const { summary, nodes, workloads } = data

  // 1. Stat cards configs
  const statCards = [
    {
      label: t("distribution.stat.podImbalance"),
      value: summary.podImbalance,
      color: summary.podImbalance >= 15 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
      bg: summary.podImbalance >= 15
        ? "bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/40"
        : "bg-card border-border",
      caption: t("distribution.stat.podImbalanceCaption"),
    },
    {
      label: t("distribution.stat.concentratedWorkloads"),
      value: summary.concentratedWorkloads,
      color: summary.concentratedWorkloads > 0 ? "text-red-600 dark:text-red-400" : "text-foreground",
      bg: summary.concentratedWorkloads > 0
        ? "bg-red-50/50 border-red-200 dark:bg-red-950/20 dark:border-red-900/40"
        : "bg-card border-border",
      caption: t("distribution.stat.concentratedWorkloadsCaption"),
    },
    {
      label: t("distribution.stat.unguardedWorkloads"),
      value: summary.unguardedWorkloads,
      color: summary.unguardedWorkloads > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
      bg: summary.unguardedWorkloads > 0
        ? "bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/40"
        : "bg-card border-border",
      caption: t("distribution.stat.unguardedWorkloadsCaption"),
    },
    {
      label: t("distribution.stat.controlPlaneWorkloadPods"),
      value: summary.controlPlaneWorkloadPods,
      color: summary.controlPlaneWorkloadPods > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground",
      bg: summary.controlPlaneWorkloadPods > 0
        ? "bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/40"
        : "bg-card border-border",
      caption: t("distribution.stat.controlPlaneWorkloadPodsCaption"),
    },
  ]

  // Find max pods count to normalize the horizontal bar width
  const maxPodCount = Math.max(1, ...nodes.map((n) => n.podCount))

  // Workload x Node matrix preparation
  const multiReplicaWorkloads = workloads.filter((w) => w.replicas >= 2)
  const activeNodeNames = Array.from(
    new Set(multiReplicaWorkloads.flatMap((w) => w.nodes.map((n) => n.node)))
  ).sort()

  return (
    <div className="space-y-6">
      {/* 4 Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map((card, idx) => (
          <div
            key={idx}
            className={`rounded-lg border p-4 flex flex-col justify-between transition-all ${card.bg}`}
          >
            <div>
              <div className="text-xs font-medium text-muted-foreground">{card.label}</div>
              <div className={`text-2xl font-bold mt-1.5 ${card.color}`}>{card.value}</div>
            </div>
            {card.caption && (
              <div className="text-[10px] text-muted-foreground mt-2 font-medium">
                {card.caption}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Node Load Bars */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">
            {t("distribution.nodeList.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {nodes.map((node) => {
            const barWidth = `${(node.podCount / maxPodCount) * 100}%`
            const isControlPlane = node.role === "control-plane"

            return (
              <Link
                key={node.node}
                href={`/nodes/${node.node}`}
                className="group flex flex-col sm:flex-row sm:items-center justify-between p-3 border rounded-lg hover:border-primary/50 hover:bg-muted/10 transition-all gap-3"
              >
                <div className="flex items-center gap-2 min-w-[200px] shrink-0">
                  <span className="font-medium text-sm text-foreground group-hover:text-primary transition-colors">
                    {node.node}
                  </span>
                  {isControlPlane && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 uppercase shrink-0">
                      {t("distribution.nodeList.controlPlane")}
                    </Badge>
                  )}
                </div>

                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden max-w-md">
                    <div
                      className={`h-full rounded-full transition-all ${
                        isControlPlane
                          ? "bg-slate-400 dark:bg-slate-600"
                          : "bg-primary"
                      }`}
                      style={{ width: barWidth }}
                    />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground shrink-0 w-16">
                    {t("distribution.nodeList.pods", { count: String(node.podCount) })}
                  </span>
                </div>

                <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground shrink-0">
                  <span>
                    CPU:{" "}
                    <span className="font-semibold text-foreground">
                      {node.cpuPercent !== null ? `${node.cpuPercent.toFixed(0)}%` : "-"}
                    </span>
                  </span>
                  <span>
                    Mem:{" "}
                    <span className="font-semibold text-foreground">
                      {node.memPercent !== null ? `${node.memPercent.toFixed(0)}%` : "-"}
                    </span>
                  </span>
                </div>
              </Link>
            )
          })}
        </CardContent>
      </Card>

      {/* Workload x Node Matrix */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">
            {t("distribution.matrix.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {multiReplicaWorkloads.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground italic">
              {t("distribution.matrix.empty")}
            </div>
          ) : (
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="p-3 font-semibold text-muted-foreground min-w-[240px]">
                      {t("distribution.table.workload")}
                    </th>
                    {activeNodeNames.map((nodeName) => (
                      <th
                        key={nodeName}
                        className="p-3 font-semibold text-muted-foreground text-center min-w-[120px] max-w-[160px] truncate"
                        title={nodeName}
                      >
                        {nodeName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {multiReplicaWorkloads.map((w, idx) => (
                    <tr key={idx} className="hover:bg-muted/20 transition-colors">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <Badge className={`text-[10px] px-1.5 py-0 h-4 uppercase shrink-0 ${severityBadgeClass[w.risk]}`}>
                            {w.risk}
                          </Badge>
                          <div className="truncate min-w-0">
                            <span className="text-muted-foreground text-[11px] block md:inline md:mr-1">
                              {w.namespace}/
                            </span>
                            <span className="font-medium text-foreground">{w.name}</span>
                            <span className="text-[10px] text-muted-foreground ml-1.5 font-mono">
                              ({w.kind})
                            </span>
                          </div>
                        </div>
                      </td>
                      {activeNodeNames.map((nodeName) => {
                        const nodeInfo = w.nodes.find((n) => n.node === nodeName)
                        const count = nodeInfo?.count ?? 0

                        if (count === 0) {
                          return (
                            <td key={nodeName} className="p-3 text-center text-muted-foreground/30 font-mono">
                              -
                            </td>
                          )
                        }

                        const highlightClass = w.concentrated
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-900/50"
                          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/50"

                        return (
                          <td key={nodeName} className="p-3 text-center">
                            <span className={`inline-flex items-center justify-center w-7 h-5 rounded font-bold font-mono text-[11px] ${highlightClass}`}>
                              {count}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Workload Distribution Details Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">
            {t("distribution.table.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-hidden">
          {workloads.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground italic border-t">
              {t("common.notFound")}
            </div>
          ) : (
            <div className="overflow-x-auto border-t">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="bg-muted/30 border-b border-border">
                    <th className="px-4 py-3 font-semibold text-muted-foreground">
                      {t("distribution.table.risk")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">
                      {t("distribution.table.namespace")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">
                      {t("distribution.table.workload")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">
                      {t("distribution.table.kind")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground text-center">
                      {t("distribution.table.replicas")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground text-center">
                      {t("distribution.table.nodeSpread")}
                    </th>
                    <th className="px-4 py-3 font-semibold text-muted-foreground">
                      {t("distribution.table.protection")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {workloads.map((w, idx) => (
                    <tr key={idx} className="hover:bg-muted/10 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge className={`text-[10px] px-1.5 py-0 h-4 uppercase ${severityBadgeClass[w.risk]}`}>
                          {w.risk}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-medium text-muted-foreground truncate max-w-[120px]" title={w.namespace}>
                        {w.namespace}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-foreground">{w.name}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 max-w-md">
                          {w.risk === "high" && t("distribution.table.hint.high")}
                          {w.risk === "medium" && t("distribution.table.hint.medium")}
                          {w.risk === "low" && t("distribution.table.hint.low")}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
                        {w.kind}
                      </td>
                      <td className="px-4 py-3 text-center font-mono font-medium">
                        {w.replicas}
                      </td>
                      <td className="px-4 py-3 text-center font-mono">
                        {t("distribution.table.nodeCount", { count: String(w.distinctNodes) })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {w.hasAntiAffinity && (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/40 text-[10px] px-1.5 py-0 h-4">
                              {t("distribution.table.antiAffinity")}
                            </Badge>
                          )}
                          {w.hasTopologySpread && (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/40 text-[10px] px-1.5 py-0 h-4">
                              {t("distribution.table.topologySpread")}
                            </Badge>
                          )}
                          {!w.hasAntiAffinity && !w.hasTopologySpread && (
                            <span className="text-muted-foreground text-[11px]">
                              {t("distribution.table.none")}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
