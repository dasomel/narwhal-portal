"use client"
import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import { ResourceDetailDrawer } from "./resource-detail-drawer"

interface ScorecardItem {
  service: string
  namespace: string
  scores: {
    gitops: number
    health: number
    alerting: number
    resources: number
    overall: number
  }
  details: string[]
}

type SortKey = "service" | "namespace" | "gitops" | "health" | "alerting" | "resources" | "overall"
type SortDir = "asc" | "desc"

function scoreBarColor(score: number): string {
  if (score >= 80) return "bg-green-500"
  if (score >= 50) return "bg-yellow-400"
  return "bg-red-500"
}

function scoreLabelColor(score: number): string {
  if (score >= 80) return "text-green-700"
  if (score >= 50) return "text-yellow-700"
  return "text-red-600"
}

function ScoreCell({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[40px]">
      <span className={`text-xs font-medium tabular-nums ${scoreLabelColor(score)}`}>
        {score}
      </span>
      <div className="w-10 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${scoreBarColor(score)}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

function OverallCell({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[52px]">
      <span className={`text-sm font-bold tabular-nums ${scoreLabelColor(score)}`}>
        {score}
      </span>
      <div className="w-12 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${scoreBarColor(score)}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  center,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  center?: boolean
}) {
  const active = currentKey === sortKey
  const indicator = !active ? "↕" : dir === "asc" ? "↑" : "↓"
  return (
    <th
      role="columnheader"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`pb-2 font-medium cursor-pointer select-none whitespace-nowrap group ${center ? "text-center" : ""}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        <span className={`text-xs transition-colors ${active ? "text-blue-500" : "text-muted-foreground/40 group-hover:text-muted-foreground"}`}>
          {indicator}
        </span>
      </span>
    </th>
  )
}

function avg(items: ScorecardItem[], key: keyof ScorecardItem["scores"]): number {
  if (items.length === 0) return 0
  return Math.round(items.reduce((sum, it) => sum + it.scores[key], 0) / items.length)
}

function CategoryAvgBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-muted/50 rounded p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={`text-xs font-bold tabular-nums ${scoreLabelColor(value)}`}>{value}</span>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${scoreBarColor(value)}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}

export function ScorecardTable() {
  const t = useT()
  const [sortKey, setSortKey] = useState<SortKey>("overall")
  const [sortDir, setSortDir] = useState<SortDir>("asc")
  const [selectedRow, setSelectedRow] = useState<{ namespace: string; service: string } | null>(null)

  const { data, isLoading, isError } = useQuery<ScorecardItem[]>({
    queryKey: ["governance-scorecard"],
    queryFn: async () => {
      const r = await fetch("/api/governance/scorecard")
      if (!r.ok) throw new Error("ArgoCD connection failed")
      return r.json()
    },
    refetchInterval: 30_000,
  })

  const items = Array.isArray(data) ? data : []

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const sorted = useMemo(() => {
    const copy = [...items]
    copy.sort((a, b) => {
      let av: string | number
      let bv: string | number
      if (sortKey === "service") { av = a.service; bv = b.service }
      else if (sortKey === "namespace") { av = a.namespace; bv = b.namespace }
      else { av = a.scores[sortKey]; bv = b.scores[sortKey] }
      if (av < bv) return sortDir === "asc" ? -1 : 1
      if (av > bv) return sortDir === "asc" ? 1 : -1
      return 0
    })
    return copy
  }, [items, sortKey, sortDir])

  const hp = { currentKey: sortKey, dir: sortDir, onSort: handleSort }

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-3">{t("scorecard.title")}</h2>

      {/* Legend */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <div className="bg-muted/50 rounded p-2 text-xs">
          <p className="font-semibold text-foreground mb-0.5">GitOps</p>
          <p className="text-muted-foreground">Synced = 100 pts</p>
          <p className="text-muted-foreground">OutOfSync = 30 pts</p>
        </div>
        <div className="bg-muted/50 rounded p-2 text-xs">
          <p className="font-semibold text-foreground mb-0.5">Health</p>
          <p className="text-muted-foreground">Healthy = 100 pts</p>
          <p className="text-muted-foreground">Progressing = 70 pts</p>
          <p className="text-muted-foreground">Degraded = 0 pts</p>
        </div>
        <div className="bg-muted/50 rounded p-2 text-xs">
          <p className="font-semibold text-foreground mb-0.5">Alerting</p>
          <p className="text-muted-foreground">Base = 100 pts</p>
          <p className="text-muted-foreground">-25 pts per alert</p>
        </div>
        <div className="bg-muted/50 rounded p-2 text-xs">
          <p className="font-semibold text-foreground mb-0.5">Resources</p>
          <p className="text-muted-foreground">+10 pts per resource</p>
          <p className="text-muted-foreground">Max = 100 pts</p>
        </div>
      </div>

      {/* Category averages — only when data is present */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
          <CategoryAvgBar label={t("scorecard.gitops")} value={avg(items, "gitops")} />
          <CategoryAvgBar label={t("scorecard.health")} value={avg(items, "health")} />
          <CategoryAvgBar label={t("scorecard.alerting")} value={avg(items, "alerting")} />
          <CategoryAvgBar label={t("scorecard.resources")} value={avg(items, "resources")} />
        </div>
      )}

      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : isError ? (
        <div className="h-32 bg-red-50 rounded flex items-center justify-center">
          <span className="text-sm text-red-500">{t("scorecard.error")}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground">{t("scorecard.empty")}</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <SortHeader label={t("scorecard.service")} sortKey="service" {...hp} />
                <SortHeader label={t("scorecard.namespace")} sortKey="namespace" {...hp} />
                <SortHeader label={t("scorecard.gitops")} sortKey="gitops" {...hp} center />
                <SortHeader label={t("scorecard.health")} sortKey="health" {...hp} center />
                <SortHeader label={t("scorecard.alerting")} sortKey="alerting" {...hp} center />
                <SortHeader label={t("scorecard.resources")} sortKey="resources" {...hp} center />
                <SortHeader label={t("scorecard.overall")} sortKey="overall" {...hp} center />
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr
                  key={item.service}
                  onClick={() => setSelectedRow({ namespace: item.namespace, service: item.service })}
                  className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <td className="py-2.5 font-medium">
                    <div>{item.service}</div>
                    {item.details && item.details.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {item.details.map((d, i) => (
                          <span key={i} className="text-xs text-orange-600 bg-orange-50 rounded px-1">{d}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 text-muted-foreground text-xs">{item.namespace}</td>
                  <td className="py-2.5 text-center"><ScoreCell score={item.scores.gitops} /></td>
                  <td className="py-2.5 text-center"><ScoreCell score={item.scores.health} /></td>
                  <td className="py-2.5 text-center"><ScoreCell score={item.scores.alerting} /></td>
                  <td className="py-2.5 text-center"><ScoreCell score={item.scores.resources} /></td>
                  <td className="py-2.5 text-center"><OverallCell score={item.scores.overall} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ResourceDetailDrawer
        namespace={selectedRow?.namespace ?? ""}
        app={selectedRow?.service}
        open={!!selectedRow}
        onOpenChange={(open) => !open && setSelectedRow(null)}
      />
    </Card>
  )
}
