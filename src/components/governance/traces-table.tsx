"use client"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n-client"

interface TraceEntry {
  traceID: string
  serviceName: string
  operationName: string
  duration: number
  startTime: number
  spanCount: number
}

type SortKey = "serviceName" | "operationName" | "duration" | "spanCount" | "startTime"
type SortDir = "asc" | "desc"

function durationColor(ms: number): string {
  if (ms < 100) return "text-narwhal-success"
  if (ms < 500) return "text-narwhal-warning"
  return "text-narwhal-danger"
}

function relativeTime(epochMs: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - epochMs
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t("audit.justNow")
  if (mins < 60) return t("audit.minsAgo", { mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("audit.hrsAgo", { hrs })
  return t("audit.daysAgo", { days: Math.floor(hrs / 24) })
}

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onToggle: (key: SortKey) => void
  className?: string
}

function SortHeader({ label, sortKey, current, dir, onToggle, className }: SortHeaderProps) {
  const icon = current === sortKey ? (dir === "asc" ? "↑" : "↓") : "↕"
  return (
    <th
      className={`pb-2 font-medium cursor-pointer select-none whitespace-nowrap hover:text-foreground ${className ?? ""}`}
      onClick={() => onToggle(sortKey)}
    >
      {label}{" "}
      <span className="text-xs opacity-60">{icon}</span>
    </th>
  )
}

export function TracesTable() {
  const t = useT()
  const [serviceInput, setServiceInput] = useState("")
  const [service, setService] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("startTime")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const { data = [], isLoading } = useQuery<TraceEntry[]>({
    queryKey: ["governance-traces", service],
    queryFn: () =>
      fetch(`/api/traces${service ? `?service=${encodeURIComponent(service)}` : ""}`).then((r) =>
        r.json()
      ),
    refetchInterval: 30_000,
  })

  function handleFilter(e: React.FormEvent) {
    e.preventDefault()
    setService(serviceInput.trim())
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  const sorted = useMemo(() => {
    const numeric: SortKey[] = ["duration", "spanCount", "startTime"]
    return [...data].sort((a, b) => {
      let cmp: number
      if (numeric.includes(sortKey)) {
        cmp = (a[sortKey] as number) - (b[sortKey] as number)
      } else {
        cmp = (a[sortKey] as string).localeCompare(b[sortKey] as string)
      }
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [data, sortKey, sortDir])

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="font-semibold text-foreground shrink-0">{t("traces.title")}</h2>
        <form onSubmit={handleFilter} className="flex gap-2">
          <Input
            placeholder={t("traces.filterPlaceholder")}
            value={serviceInput}
            onChange={(e) => setServiceInput(e.target.value)}
            className="w-48 h-8 text-xs"
          />
        </form>
      </div>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : data.length === 0 ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground">{t("traces.empty")}</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium">{t("traces.traceId")}</th>
                <SortHeader
                  label={t("traces.service")}
                  sortKey="serviceName"
                  current={sortKey}
                  dir={sortDir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label={t("traces.operation")}
                  sortKey="operationName"
                  current={sortKey}
                  dir={sortDir}
                  onToggle={toggleSort}
                />
                <SortHeader
                  label={t("traces.duration")}
                  sortKey="duration"
                  current={sortKey}
                  dir={sortDir}
                  onToggle={toggleSort}
                  className="text-right"
                />
                <SortHeader
                  label={t("traces.spans")}
                  sortKey="spanCount"
                  current={sortKey}
                  dir={sortDir}
                  onToggle={toggleSort}
                  className="text-right"
                />
                <SortHeader
                  label={t("traces.time")}
                  sortKey="startTime"
                  current={sortKey}
                  dir={sortDir}
                  onToggle={toggleSort}
                  className="text-right"
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((trace) => (
                <tr key={trace.traceID} className="border-b last:border-0">
                  <td className="py-2.5">
                    <span
                      className="font-mono text-xs text-foreground"
                      title={trace.traceID}
                    >
                      {trace.traceID.slice(0, 8)}…
                    </span>
                  </td>
                  <td className="py-2.5 text-xs text-foreground">{trace.serviceName || "—"}</td>
                  <td className="py-2.5 text-xs text-muted-foreground max-w-xs truncate">
                    {trace.operationName || "—"}
                  </td>
                  <td className={`py-2.5 text-xs font-medium text-right ${durationColor(trace.duration)}`}>
                    {trace.duration}ms
                  </td>
                  <td className="py-2.5 text-xs text-muted-foreground text-right">{trace.spanCount}</td>
                  <td className="py-2.5 text-xs text-muted-foreground text-right whitespace-nowrap">
                    {trace.startTime ? relativeTime(trace.startTime, t) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
