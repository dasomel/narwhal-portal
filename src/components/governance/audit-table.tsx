"use client"
import { useQuery } from "@tanstack/react-query"
import { useState, useMemo } from "react"
import { useSession } from "next-auth/react"
import { Card } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { useT, useLocale } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"

interface AuditEntry {
  id: string
  timestamp: string
  firstTimestamp: string
  actor: string
  action: string
  resource: string
  kind: string
  name: string
  namespace: string
  detail: string
  type: string
  count: number
  source: string
}

type SortKey = "timestamp" | "action" | "resource" | "namespace"
type SortDir = "asc" | "desc"

function relativeTime(ts: string, tFn: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return tFn("audit.justNow")
  if (mins < 60) return tFn("audit.minsAgo", { mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tFn("audit.hrsAgo", { hrs })
  return tFn("audit.daysAgo", { days: Math.floor(hrs / 24) })
}

function formatTs(ts: string, locale: string): string {
  if (!ts) return "—"
  return new Date(ts).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-2 border-b last:border-0">
      <span className="text-xs text-muted-foreground pt-0.5">{label}</span>
      <span className="text-sm text-foreground break-all">{value ?? "—"}</span>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onToggle,
  className,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onToggle: (key: SortKey) => void
  className?: string
}) {
  const active = currentKey === sortKey
  const indicator = active ? (currentDir === "asc" ? "↑" : "↓") : "↕"
  return (
    <th
      role="columnheader"
      aria-sort={active ? (currentDir === "asc" ? "ascending" : "descending") : "none"}
      className={`pb-2 font-medium cursor-pointer select-none whitespace-nowrap ${className ?? ""}`}
      onClick={() => onToggle(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${active ? "text-foreground" : "text-muted-foreground/30"}`}>{indicator}</span>
      </span>
    </th>
  )
}

export function AuditTable() {
  const t = useT()
  const locale = useLocale()
  const { data: session } = useSession()
  const role = session?.user?.role ?? "guest"
  const [nsFilter, setNsFilter] = useState("all")
  const [selected, setSelected] = useState<AuditEntry | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>("timestamp")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const { data = [], isLoading } = useQuery<AuditEntry[]>({
    queryKey: ["governance-audit"],
    queryFn: () => fetch("/api/governance/audit").then((r) => r.json()),
    refetchInterval: 30_000,
    enabled: role === "cluster-admin",
  })

  const namespaces = useMemo(() => {
    const set = new Set(data.map((e) => e.namespace).filter(Boolean))
    return Array.from(set).sort()
  }, [data])

  const filtered = useMemo(
    () => (nsFilter === "all" ? data : data.filter((e) => e.namespace === nsFilter)),
    [data, nsFilter]
  )

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      let cmp: number
      if (sortKey === "timestamp") {
        cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      } else {
        cmp = (a[sortKey] ?? "").localeCompare(b[sortKey] ?? "")
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return copy
  }, [filtered, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  if (role !== "cluster-admin") {
    return (
      <Card className="p-5">
        <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">
          {t("audit.forbidden")}
        </div>
      </Card>
    )
  }

  return (
    <>
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">{t("audit.title")}</h2>
          <select
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            className="text-xs border border-border rounded px-2 py-1 text-muted-foreground bg-background focus:outline-none focus:ring-1 focus:ring-gray-300"
          >
            <option value="all">{t("audit.filterAll")}</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        </div>
        {isLoading ? (
          <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : sorted.length === 0 ? (
          <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
            <span className="text-sm text-muted-foreground">{t("audit.empty")}</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <SortHeader
                    label={t("audit.time")}
                    sortKey="timestamp"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onToggle={toggleSort}
                    className="w-20"
                  />
                  <SortHeader
                    label={t("audit.action")}
                    sortKey="action"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortHeader
                    label={t("audit.resource")}
                    sortKey="resource"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <SortHeader
                    label={t("audit.namespace")}
                    sortKey="namespace"
                    currentKey={sortKey}
                    currentDir={sortDir}
                    onToggle={toggleSort}
                  />
                  <th className="pb-2 font-medium">{t("audit.detail")}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((entry) => (
                  <tr
                    key={entry.id}
                    onClick={() => setSelected(entry)}
                    className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <td className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {entry.timestamp ? relativeTime(entry.timestamp, t) : "—"}
                    </td>
                    <td className="py-2 text-xs font-medium text-foreground">
                      <div className="flex items-center gap-1.5">
                        {entry.type === "Warning" && (
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                        )}
                        {entry.action}
                      </div>
                    </td>
                    <td className="py-2 text-xs font-mono text-muted-foreground">{entry.resource}</td>
                    <td className="py-2 text-xs text-muted-foreground">{entry.namespace || "—"}</td>
                    <td className="py-2 text-xs text-muted-foreground max-w-xs truncate" title={entry.detail}>
                      {entry.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full max-w-md overflow-y-auto overflow-x-hidden">
          {selected && (
            <>
              <SheetHeader className="mb-2">
                <SheetTitle className="text-base">{t("audit.detail.title")}</SheetTitle>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant={selected.type === "Warning" ? "destructive" : "secondary"}>
                    {selected.type || "Normal"}
                  </Badge>
                  {selected.count > 1 && (
                    <span className="text-xs text-muted-foreground">×{selected.count}</span>
                  )}
                </div>
              </SheetHeader>

              <div className="px-4 pb-4">
                <DetailRow label={t("audit.action")} value={
                  <span className="font-medium">{selected.action}</span>
                } />
                <DetailRow label={t("audit.resource")} value={
                  <span className="font-mono text-xs break-all">{selected.resource}</span>
                } />
                <DetailRow label={t("audit.namespace")} value={selected.namespace || "—"} />
                <DetailRow label={t("audit.detail.lastSeen")} value={formatTs(selected.timestamp, locale)} />
                <DetailRow label={t("audit.detail.firstSeen")} value={formatTs(selected.firstTimestamp, locale)} />
                <DetailRow label={t("audit.detail.count")} value={String(selected.count ?? 1)} />
                <DetailRow label={t("audit.detail.actor")} value={selected.actor} />
                <DetailRow label={t("audit.detail.source")} value={selected.source || "—"} />
                <DetailRow label={t("audit.detail.message")} value={
                  <span className="text-xs leading-relaxed whitespace-pre-wrap">{selected.detail}</span>
                } />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
