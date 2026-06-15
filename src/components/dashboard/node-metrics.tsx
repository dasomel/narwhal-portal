"use client"
import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"

interface NodeMetric {
  node: string
  role: string
  cpu: { cores: number; usagePercent: number }
  memory: { totalBytes: number; usagePercent: number }
  disk: { totalBytes: number; usagePercent: number }
}

interface MetricsResponse {
  nodeMetrics?: NodeMetric[]
}

type SortKey = "node" | "role" | "cpu" | "memory" | "disk"
type SortDir = "asc" | "desc"

function formatGi(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function progressColor(percent: number): string {
  if (percent > 80) return "bg-narwhal-danger"
  if (percent > 60) return "bg-narwhal-warning"
  return "bg-narwhal-success"
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 bg-muted rounded-full h-2">
        <div
          className={`h-2 rounded-full ${progressColor(percent)}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right">{percent}%</span>
    </div>
  )
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (col: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th
      className="pb-2 pr-4 font-medium cursor-pointer select-none whitespace-nowrap"
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className="text-xs text-muted-foreground">
          {active ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
        </span>
      </span>
    </th>
  )
}

export function NodeMetrics() {
  const t = useT()
  const router = useRouter()
  const [sortKey, setSortKey] = useState<SortKey>("node")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const { data, isLoading } = useQuery<MetricsResponse>({
    queryKey: ["metrics"],
    queryFn: () => fetch("/api/metrics").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const nodes = data?.nodeMetrics

  const sorted = useMemo(() => {
    if (!nodes) return []
    return [...nodes].sort((a, b) => {
      let cmp = 0
      if (sortKey === "node") cmp = a.node.localeCompare(b.node)
      else if (sortKey === "role") cmp = a.role.localeCompare(b.role)
      else if (sortKey === "cpu") cmp = a.cpu.usagePercent - b.cpu.usagePercent
      else if (sortKey === "memory") cmp = a.memory.usagePercent - b.memory.usagePercent
      else if (sortKey === "disk") cmp = a.disk.usagePercent - b.disk.usagePercent
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [nodes, sortKey, sortDir])

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortKey(col); setSortDir("asc") }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("nodeMetrics.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-48 bg-muted/50 rounded flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : !nodes || nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nodeMetrics.noData")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <SortHeader label={t("nodeMetrics.node")} col="node" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label={t("nodeMetrics.role")} col="role" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label="CPU" col="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Memory" col="memory" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <th
                    className="pb-2 font-medium cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort("disk")}
                  >
                    <span className="inline-flex items-center gap-1">
                      Disk
                      <span className="text-xs text-muted-foreground">
                        {sortKey === "disk" ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((n) => (
                  <tr
                    key={n.node}
                    className="border-b last:border-0 cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(`/nodes/${n.node}`)}
                  >
                    <td className="py-3 pr-4 font-medium text-foreground">{n.node}</td>
                    <td className="py-3 pr-4">
                      <Badge
                        className={
                          n.role === "control-plane"
                            ? "bg-purple-100 text-purple-700 hover:bg-purple-100"
                            : "bg-narwhal-accent/15 text-narwhal-accent hover:bg-narwhal-accent/15"
                        }
                      >
                        {n.role}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 min-w-[120px]">
                      <span className="text-foreground">{n.cpu.cores} cores</span>
                      <ProgressBar percent={n.cpu.usagePercent} />
                    </td>
                    <td className="py-3 pr-4 min-w-[120px]">
                      <span className="text-foreground">{formatGi(n.memory.totalBytes)} Gi</span>
                      <ProgressBar percent={n.memory.usagePercent} />
                    </td>
                    <td className="py-3 min-w-[120px]">
                      <span className="text-foreground">{formatGi(n.disk.totalBytes)} Gi</span>
                      <ProgressBar percent={n.disk.usagePercent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
