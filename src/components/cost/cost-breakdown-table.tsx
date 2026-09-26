"use client"

/**
 * CostBreakdownTable — spec §5.5 Namespace/Service 토글, 표 정렬, 행 클릭 → 상세
 */

import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useT } from "@/lib/i18n-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

interface CostItem {
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number
}

// portal#64 AC3/AC4: structured mirrors of CostExclusions/CostTelemetry in
// src/lib/cost.ts, so this table can show exclusions and render an "unavailable"
// telemetry state distinctly from a genuinely empty result.
interface UnlabeledWorkloadsExclusion {
  computable: boolean
  count: number | null
  hourly: number | null
}

interface CostExclusions {
  unlabeledWorkloads?: UnlabeledWorkloadsExclusion
  storageExcludedFromServiceScope?: boolean
}

interface CostTelemetry {
  state: "ok" | "empty" | "unavailable" | "partial" | "ambiguous" | "stale"
}

interface CostResponse {
  scope: string
  generatedAt: string
  unitPrices: { cpuHourly: number; memGbHourly: number; storageGbHourly: number }
  items: CostItem[]
  notice?: string
  telemetry?: CostTelemetry
  exclusions?: CostExclusions
}

type SortKey = "id" | "cpu" | "memory" | "storage" | "monthly"
type SortDir = "asc" | "desc"
type ScopeView = "namespace" | "service"

export function CostBreakdownTable() {
  const t = useT()
  const router = useRouter()
  const [scopeView, setScopeView] = useState<ScopeView>("namespace")
  const [sortKey, setSortKey] = useState<SortKey>("monthly")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const { data, isLoading, error } = useQuery<CostResponse>({
    queryKey: ["cost", scopeView],
    queryFn: async () => {
      const response = await fetch(`/api/cost?scope=${scopeView}`)
      if (!response.ok) throw new Error("Cost data is unavailable")
      return response.json()
    },
    refetchInterval: 60_000,
  })

  const sorted = useMemo(() => {
    const items = data?.items ?? []
    return [...items].sort((a, b) => {
      let av = 0
      let bv = 0
      switch (sortKey) {
        case "id":
          return sortDir === "asc"
            ? a.id.localeCompare(b.id)
            : b.id.localeCompare(a.id)
        case "cpu":
          av = a.cpu.hourly; bv = b.cpu.hourly; break
        case "memory":
          av = a.memory.hourly; bv = b.memory.hourly; break
        case "storage":
          av = a.storage.hourly; bv = b.storage.hourly; break
        case "monthly":
        default:
          av = a.totalMonthly; bv = b.totalMonthly; break
      }
      return sortDir === "asc" ? av - bv : bv - av
    })
  }, [data?.items, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  function handleRowClick(item: CostItem) {
    if (scopeView === "service") {
      router.push(`/catalog/${item.id}?tab=cost`)
      return
    }
    router.push(`/catalog?namespace=${encodeURIComponent(item.id)}`)
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="ml-1 text-muted-foreground/40">↕</span>
    return (
      <span className="ml-1 text-foreground">
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-foreground">
            {t("cost.breakdownTitle")}
          </CardTitle>
          {/* Namespace / Service 토글 */}
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              onClick={() => setScopeView("namespace")}
              aria-pressed={scopeView === "namespace"}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                scopeView === "namespace"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("cost.namespace")}
            </button>
            <button
              onClick={() => setScopeView("service")}
              aria-pressed={scopeView === "service"}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                scopeView === "service"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("cost.service")}
            </button>
          </div>
        </div>
        {/* 크리틱 리뷰 #4: partial/unavailable을 notice 유무와 무관하게 명시적 배너로
            보여준다 — 이전에는 items가 비어 있을 때만 텍스트를 바꿨고, partial처럼
            items가 채워져 있는 degraded 상태는 아예 표시되지 않았다. */}
        {data?.telemetry?.state === "unavailable" ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t("cost.telemetryUnavailable")}
          </div>
        ) : data?.telemetry?.state === "partial" ? (
          <p className="mt-2 text-xs text-yellow-700 dark:text-yellow-400">
            {t("cost.telemetryPartial")}
          </p>
        ) : null}
        {data?.notice && (
          <p className="mt-2 text-xs text-yellow-700 dark:text-yellow-400">
            {data.notice}
          </p>
        )}
        {/* portal#64 AC3: unlabeled workload exclusion, shown as a structured
            value rather than only inside the free-text `notice` above.
            Codex 리뷰 #4: computable===false를 조용히 숨기지 않고 명시적으로
            "집계 불가"라고 알린다 — 이전에는 그 조회 실패가 화면에서 사라져서
            제외 항목이 실제로는 0인 것처럼 보였다. */}
        {scopeView === "service" && data?.exclusions?.unlabeledWorkloads && (
          data.exclusions.unlabeledWorkloads.computable ? (
            (data.exclusions.unlabeledWorkloads.count ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("cost.unlabeledWorkloadsExclusion", {
                  count: String(data.exclusions.unlabeledWorkloads.count),
                  hourly: `$${(data.exclusions.unlabeledWorkloads.hourly ?? 0).toFixed(4)}`,
                })}
              </p>
            )
          ) : (
            <p className="mt-1 text-xs text-yellow-700 dark:text-yellow-400">
              {t("cost.exclusionsUnavailable")}
            </p>
          )
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-destructive">
            {t("cost.dataUnavailable")}
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {data?.telemetry?.state === "unavailable"
              ? t("cost.telemetryUnavailable")
              : t("cost.noDataPrometheus")}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  className="cursor-pointer select-none"
                  role="button"
                  tabIndex={0}
                  aria-sort={sortKey === "id" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort("id")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleSort("id")
                    }
                  }}
                >
                  {scopeView === "namespace" ? t("cost.namespace") : t("cost.service")}
                  <SortIcon col="id" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  role="button"
                  tabIndex={0}
                  aria-sort={sortKey === "cpu" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort("cpu")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleSort("cpu")
                    }
                  }}
                >
                  {t("cost.cpuHourlyShort")}
                  <SortIcon col="cpu" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  role="button"
                  tabIndex={0}
                  aria-sort={sortKey === "memory" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort("memory")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleSort("memory")
                    }
                  }}
                >
                  {t("cost.memoryHourlyShort")}
                  <SortIcon col="memory" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  role="button"
                  tabIndex={0}
                  aria-sort={sortKey === "storage" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort("storage")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleSort("storage")
                    }
                  }}
                >
                  {t("cost.storageHourlyShort")}
                  <SortIcon col="storage" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  role="button"
                  tabIndex={0}
                  aria-sort={sortKey === "monthly" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => toggleSort("monthly")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleSort("monthly")
                    }
                  }}
                >
                  {t("cost.monthlyEstimate")}
                  <SortIcon col="monthly" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((item) => (
                <TableRow
                  key={item.id}
                  className="cursor-pointer hover:bg-muted/50"
                  role="link"
                  tabIndex={0}
                  aria-label={t("cost.openDetails", { name: item.id })}
                  onClick={() => handleRowClick(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      handleRowClick(item)
                    }
                  }}
                >
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {scopeView === "namespace" ? t("cost.namespaceShort") : t("cost.serviceShort")}
                      </Badge>
                      {item.id}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs text-indigo-600 dark:text-indigo-400">
                    ${item.cpu.hourly.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-emerald-600 dark:text-emerald-400">
                    ${item.memory.hourly.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-orange-600 dark:text-orange-400">
                    ${item.storage.hourly.toFixed(4)}
                  </TableCell>
                  <TableCell className="text-right text-sm font-semibold">
                    ${item.totalMonthly.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
