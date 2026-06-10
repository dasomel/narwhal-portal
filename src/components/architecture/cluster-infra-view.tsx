"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useT } from "@/lib/i18n-client"
import type { ClusterInfra } from "@/app/api/cluster/route"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

const SYSTEM_NAMESPACES = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "cert-manager",
  "istio-system",
  "metallb-system",
  "platform-system",
  "devtools",
  "iam",
  "monitoring",
  "logging",
  "tracing",
])

function usageColor(percent: number): string {
  if (percent >= 90) return "bg-narwhal-danger"
  if (percent >= 70) return "bg-narwhal-warning"
  return "bg-narwhal-success"
}

function UsageBar({ percent }: { percent: number | null }) {
  if (percent === null) {
    return (
      <div className="flex items-center gap-2 min-w-[100px]">
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden" />
        <span className="text-xs text-muted-foreground w-8 text-right">N/A</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${usageColor(percent)}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right">{percent}%</span>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: "green" | "red" | "default"
}) {
  const accentClass =
    accent === "green"
      ? "text-narwhal-success"
      : accent === "red"
        ? "text-narwhal-danger"
        : "text-foreground"
  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col gap-1">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <p className={`text-2xl font-bold ${accentClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <TableRow>
      {Array.from({ length: cols }).map((_, i) => (
        <TableCell key={i}>
          <div className="h-4 bg-muted rounded animate-pulse w-20" />
        </TableCell>
      ))}
    </TableRow>
  )
}

export function ClusterInfraView() {
  const t = useT()

  const { data, isLoading, error } = useQuery<ClusterInfra>({
    queryKey: ["cluster-infra"],
    queryFn: () => fetch("/api/cluster").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const cpReady = data ? data.controlPlane.filter((c) => c.status === "Running").length : 0
  const cpTotal = data?.controlPlane.length ?? 0

  return (
    <div className="space-y-6">
      {/* 섹션 1: 요약 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-2">
              <div className="h-3 bg-muted rounded animate-pulse w-16" />
              <div className="h-7 bg-muted rounded animate-pulse w-24" />
            </div>
          ))
        ) : error ? (
          <div className="col-span-4 rounded-lg border border-narwhal-danger/30 bg-narwhal-danger/10 p-4 text-sm text-narwhal-danger">
            {t("common.loadError")}
          </div>
        ) : data ? (
          <>
            <SummaryCard
              label={t("arch.nodes")}
              value={`${data.summary.readyNodes}/${data.summary.totalNodes} ${t("arch.ready")}`}
              accent={data.summary.readyNodes === data.summary.totalNodes ? "green" : "red"}
            />
            <SummaryCard
              label={t("arch.pods")}
              value={String(data.summary.totalPods)}
              sub={t("arch.running")}
              accent="default"
            />
            <SummaryCard
              label={t("arch.namespaces")}
              value={String(data.summary.totalNamespaces)}
              accent="default"
            />
            <SummaryCard
              label={t("arch.controlPlane")}
              value={`${cpReady}/${cpTotal} ${t("arch.running")}`}
              accent={cpReady === cpTotal && cpTotal > 0 ? "green" : "red"}
            />
          </>
        ) : null}
      </div>

      {/* 섹션 2: 노드 상태 테이블 */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h2 className="text-sm font-semibold text-foreground">{t("arch.nodes")}</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">{t("arch.nodes")}</TableHead>
              <TableHead>{t("arch.role")}</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-36">{t("arch.cpu")}</TableHead>
              <TableHead className="w-36">{t("arch.memory")}</TableHead>
              <TableHead className="w-24">{t("arch.pods")}</TableHead>
              <TableHead>{t("arch.version")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} cols={7} />)
            ) : !data || data.nodes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                  {t("common.loadError")}
                </TableCell>
              </TableRow>
            ) : (
              data.nodes.map((node) => (
                <TableRow key={node.name}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/nodes/${node.name}`}
                      className="text-narwhal-accent hover:underline text-sm"
                    >
                      {node.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {node.roles.map((r) => (
                        <Badge key={r} variant="outline" className="text-xs">
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={node.status === "Ready" ? "default" : "destructive"}
                      className={`text-xs ${node.status === "Ready" ? "bg-narwhal-success/15 text-narwhal-success hover:bg-narwhal-success/10 border-narwhal-success/30" : ""}`}
                    >
                      {node.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <UsageBar percent={node.cpu.percent} />
                  </TableCell>
                  <TableCell>
                    <UsageBar percent={node.memory.percent} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {node.pods.running}/{node.pods.total}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {node.kubeletVersion}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 섹션 3: 네임스페이스 그리드 */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">{t("arch.namespaces")}</h2>
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-14 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        ) : !data || data.namespaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common.loadError")}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {data.namespaces.map((ns) => {
              const isSystem = SYSTEM_NAMESPACES.has(ns.name)
              return (
                <div
                  key={ns.name}
                  className={`rounded-lg border p-3 flex flex-col gap-1 ${
                    isSystem
                      ? "border-narwhal-accent/20 bg-narwhal-accent/10"
                      : "border-border/50 bg-muted/30"
                  } ${ns.status === "Terminating" ? "opacity-50" : ""}`}
                >
                  <p
                    className={`text-xs font-medium truncate ${isSystem ? "text-narwhal-accent" : "text-foreground"}`}
                    title={ns.name}
                  >
                    {ns.name}
                  </p>
                  <div className="flex items-center gap-1">
                    <Badge
                      variant="outline"
                      className="text-xs px-1 py-0 h-4 border-border text-muted-foreground"
                    >
                      {ns.podCount} {t("arch.pods")}
                    </Badge>
                    {ns.status === "Terminating" && (
                      <Badge variant="destructive" className="text-xs px-1 py-0 h-4">
                        Terminating
                      </Badge>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
