"use client"
import { useState, useMemo, useCallback, Fragment } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { translateTitle, translateRemediation } from "@/lib/check-translations"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import type { RbacAuditRow, RbacAuditDetail, Severity } from "@/types/compliance"

type SortKey = "namespace" | "kind" | "name" | "Critical" | "High" | "Medium" | "Low"
type SortDir = "asc" | "desc"

function SortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
}) {
  const active = currentKey === sortKey
  const indicator = !active ? "↕" : dir === "asc" ? "↑" : "↓"
  return (
    <th
      role="columnheader"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className="px-4 py-3 font-medium cursor-pointer select-none whitespace-nowrap group"
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

const PAGE_SIZE = 20

const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low"]

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

function SeverityMini({ severity, count }: { severity: Severity; count: number }) {
  if (!count) return null
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${severityBadgeClass[severity]}`}>
      {count}
    </span>
  )
}

function ExpandedRbacPanel({
  namespace,
  name,
}: {
  namespace: string
  name: string
}) {
  const t = useT()
  const locale = useLocale()

  const { data: detail, isLoading } = useQuery<RbacAuditDetail>({
    queryKey: ["compliance-rbac-detail", namespace, name],
    queryFn: () =>
      fetch(
        `/api/compliance/rbac-audit?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`
      ).then((r) => r.json()),
    enabled: true,
    staleTime: 60_000,
  })

  const top5Failed = useMemo(() => {
    if (!detail?.checks) return []
    const order: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]
    return detail.checks
      .filter((c) => !c.success)
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
      .slice(0, 5)
  }, [detail])

  return (
    <div className="px-6 py-4 bg-muted/10 border-t border-dashed">
      {isLoading ? (
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      ) : detail ? (
        <div className="space-y-3">
          {top5Failed.length === 0 ? (
            <div className="rounded-md border border-green-200 bg-green-50/60 dark:bg-green-950/10 dark:border-green-900 p-3 text-xs">
              <p className="font-medium text-green-700 dark:text-green-400">✓ {t("compliance.check.allPassed")}</p>
              <p className="text-muted-foreground mt-1">{t("compliance.check.allPassedHint")}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {top5Failed.map((check) => (
                  <div
                    key={check.id}
                    className="rounded-md border border-red-200 bg-red-50/60 dark:bg-red-950/10 dark:border-red-900 p-2.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-muted-foreground">{check.id}</span>
                      <Badge className={`text-xs ${severityBadgeClass[check.severity] ?? severityBadgeClass.Unknown}`}>
                        {check.severity}
                      </Badge>
                    </div>
                    <p className="mt-1 font-medium text-foreground">{translateTitle("ksv", check.id, check.title, locale)}</p>
                    {check.remediation && (
                      <p className="mt-1 text-muted-foreground line-clamp-2">{translateRemediation("ksv", check.id, check.remediation, locale)}</p>
                    )}
                  </div>
                ))}
              </div>
              <div>
                <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href={`/compliance/rbac-audit/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`}>
                    {t("common.viewFullDetails")}
                  </a>
              </div>
            </>
          )}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{t("common.notFound")}</span>
      )}
    </div>
  )
}

export function RbacAuditTable() {
  const t = useT()
  const [severity, setSeverity] = useState<Severity | "all">("all")
  const [namespace, setNamespace] = useState("all")
  const [nameSearch, setNameSearch] = useState("")
  const [page, setPage] = useState(1)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>("Critical")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  const queryParams = new URLSearchParams()
  if (severity !== "all") queryParams.set("severity", severity)
  if (namespace !== "all") queryParams.set("namespace", namespace)

  const { data: rows = [], isLoading } = useQuery<RbacAuditRow[]>({
    queryKey: ["compliance-rbac-audit", severity, namespace],
    queryFn: () => fetch(`/api/compliance/rbac-audit?${queryParams}`).then((r) => r.json()),
    staleTime: 60_000,
  })

  const allNamespaces = useMemo(
    () => Array.from(new Set(rows.map((r) => r.namespace))).sort(),
    [rows]
  )

  // Split by role ownership: findings on K8s built-in roles or upstream controller/chart roles
  // are inherent to what those roles do and not actionable by the platform team (see
  // isAcceptedRbacRole in lib/compliance.ts). Only our own authored roles are actionable.
  const { actionableCount, acceptedCount } = useMemo(() => {
    let actionableCount = 0
    let acceptedCount = 0
    for (const r of rows) {
      if (r.accepted) acceptedCount++
      else actionableCount++
    }
    return { actionableCount, acceptedCount }
  }, [rows])

  const filtered = useMemo(() => {
    if (!nameSearch.trim()) return rows
    const q = nameSearch.toLowerCase()
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q))
  }, [rows, nameSearch])

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "namespace" || key === "kind" || key === "name" ? "asc" : "desc")
    }
    setPage(1)
  }

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      if (sortKey === "namespace" || sortKey === "kind" || sortKey === "name") {
        const av = sortKey === "namespace" ? a.namespace : sortKey === "kind" ? a.kind : a.name
        const bv = sortKey === "namespace" ? b.namespace : sortKey === "kind" ? b.kind : b.name
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      const av = a.summary[sortKey]
      const bv = b.summary[sortKey]
      if (av < bv) return sortDir === "asc" ? -1 : 1
      if (av > bv) return sortDir === "asc" ? 1 : -1
      return 0
    })
    return copy
  }, [filtered, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleNameSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNameSearch(e.target.value)
    setPage(1)
  }, [])

  const toggleRow = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key))
  }, [])

  const COL_COUNT = 7

  return (
    <>
      {(actionableCount > 0 || acceptedCount > 0) && (
        <p
          className="text-xs text-muted-foreground mb-2"
          title={t("compliance.table.acceptedRbacHint")}
        >
          {t("compliance.table.rbacActionableSummary", {
            actionable: String(actionableCount),
            accepted: String(acceptedCount),
          })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Select value={severity} onValueChange={(v) => { setSeverity(v as Severity | "all"); setPage(1) }}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("compliance.filter.allSeverities")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("compliance.filter.allSeverities")}</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={namespace} onValueChange={(v) => { if (v != null) { setNamespace(v); setPage(1) } }}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder={t("compliance.filter.allNamespaces")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("compliance.filter.allNamespaces")}</SelectItem>
            {allNamespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>{ns}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-56"
          placeholder={t("compliance.filter.name")}
          value={nameSearch}
          onChange={handleNameSearch}
        />
      </div>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="h-40 flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : pageRows.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
            {t("compliance.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted/30">
                  <th className="px-3 py-3 w-8"></th>
                  <SortHeader label={t("compliance.table.namespace")} sortKey="namespace" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label={t("compliance.table.kind")} sortKey="kind" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label={t("compliance.table.name")} sortKey="name" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label="Critical" sortKey="Critical" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label="High" sortKey="High" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label="Medium" sortKey="Medium" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                  <SortHeader label="Low" sortKey="Low" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const rowKey = `${row.namespace}|${row.kind}|${row.name}`
                  const isExpanded = expandedKey === rowKey
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className="border-b hover:bg-muted/20 cursor-pointer transition-colors"
                        onClick={() => toggleRow(rowKey)}
                      >
                        <td className="px-3 py-2.5 text-muted-foreground">
                          <span
                            className="inline-block transition-transform duration-200"
                            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                            title={isExpanded ? t("common.collapse") : t("common.expand")}
                          >
                            ›
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.namespace}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{row.kind}</td>
                        <td className="px-4 py-2.5 font-medium">
                          <span>{row.name}</span>
                          {row.accepted && (
                            <Badge
                              variant="outline"
                              className="ml-2 text-[0.65rem] px-1.5 py-0 text-muted-foreground border-muted-foreground/30"
                              title={t("compliance.table.acceptedRbacHint")}
                            >
                              {t("compliance.table.acceptedRbac")}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5"><SeverityMini severity="Critical" count={row.summary.Critical} /></td>
                        <td className="px-4 py-2.5"><SeverityMini severity="High" count={row.summary.High} /></td>
                        <td className="px-4 py-2.5"><SeverityMini severity="Medium" count={row.summary.Medium} /></td>
                        <td className="px-4 py-2.5"><SeverityMini severity="Low" count={row.summary.Low} /></td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={COL_COUNT + 1} className="p-0">
                            <ExpandedRbacPanel namespace={row.namespace} name={row.name} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("security.pagination.prev")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("security.pagination.page")} {safePage} {t("security.pagination.of", { total: String(totalPages) })}
          </span>
          <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t("security.pagination.next")}
          </Button>
        </div>
      )}
    </>
  )
}
