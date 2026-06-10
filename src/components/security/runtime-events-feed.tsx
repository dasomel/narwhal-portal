"use client"
import { useState, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { translateTitle } from "@/lib/check-translations"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { FalcoEvent, FalcoEventPriority } from "@/types/security"

const priorityBadgeClass: Record<FalcoEventPriority, string> = {
  Emergency: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  Alert: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
  Critical: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Error: "bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-500",
  Warning: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Notice: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Informational: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  Debug: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
}

const ALL_PRIORITIES: FalcoEventPriority[] = [
  "Emergency", "Alert", "Critical", "Error", "Warning", "Notice", "Informational", "Debug",
]

type TimeRange = "5" | "15" | "60" | "360" | "1440"

const TIME_RANGE_LIMITS: Record<TimeRange, number> = {
  "5": 200,
  "15": 200,
  "60": 300,
  "360": 400,
  "1440": 500,
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function RuntimeEventsFeed() {
  const t = useT()
  const locale = useLocale()
  const [priority, setPriority] = useState<FalcoEventPriority | "all">("all")
  const [timeRange, setTimeRange] = useState<TimeRange>("60")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [search, setSearch] = useState("")

  const params = new URLSearchParams({
    limit: String(TIME_RANGE_LIMITS[timeRange]),
    sinceMinutes: timeRange,
  })
  if (priority !== "all") params.set("priority", priority)

  const { data: events = [], isLoading } = useQuery<FalcoEvent[]>({
    queryKey: ["security-runtime-events", priority, timeRange],
    queryFn: () => fetch(`/api/security/runtime-events?${params}`).then((r) => r.json()),
    refetchInterval: autoRefresh ? 15_000 : false,
  })

  const filtered = useMemo(() => {
    if (!search.trim()) return events
    const q = search.toLowerCase()
    return events.filter(
      (ev) =>
        (ev.pod ?? "").toLowerCase().includes(q) ||
        (ev.namespace ?? "").toLowerCase().includes(q)
    )
  }, [events, search])

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Time range */}
        <Select value={timeRange} onValueChange={(v) => { if (v != null) setTimeRange(v as TimeRange) }}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="5">{t("security.runtime.timeRange.5m")}</SelectItem>
            <SelectItem value="15">{t("security.runtime.timeRange.15m")}</SelectItem>
            <SelectItem value="60">{t("security.runtime.timeRange.1h")}</SelectItem>
            <SelectItem value="360">{t("security.runtime.timeRange.6h")}</SelectItem>
            <SelectItem value="1440">{t("security.runtime.timeRange.24h")}</SelectItem>
          </SelectContent>
        </Select>

        {/* Priority filter */}
        <Select value={priority} onValueChange={(v) => { if (v != null) setPriority(v as FalcoEventPriority | "all") }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("rbac.filterAll")}</SelectItem>
            {ALL_PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Search */}
        <Input
          className="w-56"
          placeholder={t("security.runtime.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {/* Auto-refresh toggle */}
        <label className="flex items-center gap-2 cursor-pointer ml-auto select-none">
          <span className="text-xs text-muted-foreground">{t("security.runtime.autoRefresh")}</span>
          <button
            role="switch"
            aria-checked={autoRefresh}
            onClick={() => setAutoRefresh((v) => !v)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              autoRefresh ? "bg-primary" : "bg-input"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                autoRefresh ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
          {autoRefresh && (
            <span className="text-xs text-green-600 font-medium animate-pulse">●</span>
          )}
        </label>

        <span className="text-xs text-muted-foreground">
          {filtered.length > 0 && t("security.runtime.eventCount", { count: filtered.length })}
        </span>
      </div>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="h-40 flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
            {t("security.runtime.empty")}
          </div>
        ) : (
          <ul className="divide-y max-h-[600px] overflow-y-auto">
            {filtered.map((ev) => (
              <li key={ev.id} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                <div className="flex items-start gap-3">
                  <span className="text-xs text-muted-foreground font-mono shrink-0 pt-0.5 w-20">
                    {formatTime(ev.time)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className={`text-xs shrink-0 ${priorityBadgeClass[ev.priority]}`}>
                        {ev.priority}
                      </Badge>
                      <span className="text-sm font-medium truncate">{translateTitle("falco", ev.rule, ev.rule, locale)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{ev.output}</p>
                    <div className="flex gap-2 mt-1.5 flex-wrap">
                      {ev.namespace && (
                        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono">
                          ns:{ev.namespace}
                        </span>
                      )}
                      {ev.pod && (
                        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono">
                          pod:{ev.pod}
                        </span>
                      )}
                      {ev.container && (
                        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-mono">
                          ctr:{ev.container}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
