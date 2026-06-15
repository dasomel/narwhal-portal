"use client"

/**
 * CostBreakdownTable — spec §5.5 Namespace/Service 토글, 표 정렬, 행 클릭 → 상세
 * TODO(wrap-up): i18n
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

interface CostResponse {
  scope: string
  generatedAt: string
  unitPrices: { cpuHourly: number; memGbHourly: number; storageGbHourly: number }
  items: CostItem[]
  notice?: string
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

  const { data, isLoading } = useQuery<CostResponse>({
    queryKey: ["cost", scopeView],
    queryFn: () => fetch(`/api/cost?scope=${scopeView}`).then((r) => r.json()),
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
    }
    // namespace 클릭 시 service 뷰로 전환
    // TODO(wrap-up): namespace → /catalog?namespace=X 라우팅 연결
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
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                scopeView === "namespace"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Namespace
            </button>
            <button
              onClick={() => setScopeView("service")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                scopeView === "service"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Service
            </button>
          </div>
        </div>
        {data?.notice && (
          <p className="mt-2 text-xs text-yellow-700 dark:text-yellow-400">
            {data.notice}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("cost.noDataPrometheus")}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead
                  className="cursor-pointer select-none"
                  onClick={() => toggleSort("id")}
                >
                  {scopeView === "namespace" ? "Namespace" : "Service"}
                  <SortIcon col="id" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  onClick={() => toggleSort("cpu")}
                >
                  CPU $/h
                  <SortIcon col="cpu" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  onClick={() => toggleSort("memory")}
                >
                  Mem $/h
                  <SortIcon col="memory" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  onClick={() => toggleSort("storage")}
                >
                  Stor $/h
                  <SortIcon col="storage" />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none text-right"
                  onClick={() => toggleSort("monthly")}
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
                  className={
                    scopeView === "service"
                      ? "cursor-pointer hover:bg-muted/50"
                      : "cursor-default"
                  }
                  onClick={() => handleRowClick(item)}
                >
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {scopeView === "namespace" ? "ns" : "svc"}
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
