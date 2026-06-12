"use client"
import { Fragment, useState, useMemo, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT } from "@/lib/i18n-client"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import type { WorkloadVulnRow, ImageVulnReport, Severity } from "@/types/security"

const PAGE_SIZE = 20

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]

type SortKey = "namespace" | "name" | "image" | "Critical" | "High"
type SortDir = "asc" | "desc"

function SeverityMini({ severity, count }: { severity: Severity; count: number }) {
  if (!count) return null
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${severityBadgeClass[severity]}`}>
      {count}
    </span>
  )
}

function SortableHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = current === sortKey
  return (
    <th
      className="px-4 py-3 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={() => onSort(sortKey)}
    >
      <span className="flex items-center gap-1">
        {label}
        <span className="text-xs opacity-60">
          {active ? (dir === "asc" ? "▲" : "▼") : "⇅"}
        </span>
      </span>
    </th>
  )
}

function ExpandedVulnPanel({ image }: { image: string }) {
  const t = useT()

  const { data: detail, isLoading } = useQuery<ImageVulnReport>({
    queryKey: ["security-vuln-detail", image],
    queryFn: () =>
      fetch(`/api/security/vulnerabilities?image=${encodeURIComponent(image)}`).then((r) => r.json()),
    enabled: true,
    staleTime: 60_000,
  })

  const imageB64 = typeof window !== "undefined"
    ? btoa(unescape(encodeURIComponent(image))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    : ""

  const top5 = useMemo(() => {
    if (!detail?.vulnerabilities) return []
    const order: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]
    return [...detail.vulnerabilities]
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
      .slice(0, 5)
  }, [detail])

  return (
    <div className="px-6 py-4 bg-muted/10 border-t border-dashed">
      {isLoading ? (
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      ) : detail ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{t("security.detail.workload")}: </span>
              {detail.namespace} / {detail.workload.kind} / {detail.workload.name}
            </span>
          </div>
          {top5.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="pb-1.5 pr-3 font-medium">{t("security.detail.cveId")}</th>
                    <th className="pb-1.5 pr-3 font-medium">{t("security.detail.severity")}</th>
                    <th className="pb-1.5 pr-3 font-medium">{t("security.detail.score")}</th>
                    <th className="pb-1.5 pr-3 font-medium">{t("security.detail.fixedVersion")}</th>
                    <th className="pb-1.5 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {top5.map((v) => (
                    <tr key={v.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono">{v.id}</td>
                      <td className="py-1.5 pr-3">
                        <Badge className={`text-xs ${severityBadgeClass[v.severity]}`}>{v.severity}</Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{v.score ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono">
                        {v.fixedVersion ? (
                          <span className="text-green-600">{v.fixedVersion}</span>
                        ) : (
                          <span className="text-muted-foreground">{t("security.detail.noFix")}</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        {v.primaryLink && (
                          <a
                            href={v.primaryLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline whitespace-nowrap"
                          >
                            {t("security.openInNvd")}
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {top5.length === 0 ? (
            <div className="rounded-md border border-green-200 bg-green-50/60 dark:bg-green-950/10 dark:border-green-900 p-3 text-xs">
              <p className="font-medium text-green-700 dark:text-green-400">✓ {t("security.vuln.noFindings")}</p>
              <p className="text-muted-foreground mt-1">{t("security.vuln.noFindingsHint")}</p>
            </div>
          ) : (
            <div>
              <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href={`/security/image/${imageB64}`}>{t("common.viewFullDetails")}</a>
            </div>
          )}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{t("common.notFound")}</span>
      )}
    </div>
  )
}

interface Props {
  initialData?: WorkloadVulnRow[]
}

export function VulnerabilitiesTable({ initialData }: Props) {
  const t = useT()

  const [severity, setSeverity] = useState<Severity | "all">("all")
  const [namespace, setNamespace] = useState<string>("all")
  const [imageSearch, setImageSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("Critical")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [page, setPage] = useState(1)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const queryParams = new URLSearchParams()
  if (severity !== "all") queryParams.set("severity", severity)
  if (namespace !== "all") queryParams.set("namespace", namespace)

  const { data: rows = [], isLoading } = useQuery<WorkloadVulnRow[]>({
    queryKey: ["security-vulnerabilities", severity, namespace],
    queryFn: () =>
      fetch(`/api/security/vulnerabilities?${queryParams}`).then((r) => r.json()),
    initialData: severity === "all" && namespace === "all" ? initialData : undefined,
    staleTime: 60_000,
  })

  const allNamespaces = useMemo(() => {
    const source = initialData && initialData.length > 0 ? initialData : rows
    return Array.from(new Set(source.map((r) => r.namespace))).sort()
  }, [initialData, rows])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
      } else {
        setSortKey(key)
        setSortDir("desc")
      }
      setPage(1)
    },
    [sortKey]
  )

  const filtered = useMemo(() => {
    let result = rows
    if (imageSearch.trim()) {
      const q = imageSearch.toLowerCase()
      result = result.filter((r) => r.image.toLowerCase().includes(q))
    }
    return [...result].sort((a, b) => {
      let av: string | number
      let bv: string | number
      if (sortKey === "Critical" || sortKey === "High") {
        av = a.summary[sortKey]
        bv = b.summary[sortKey]
      } else if (sortKey === "name") {
        av = a.name
        bv = b.name
      } else if (sortKey === "image") {
        av = a.image
        bv = b.image
      } else {
        av = a.namespace
        bv = b.namespace
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1
      if (av > bv) return sortDir === "asc" ? 1 : -1
      return 0
    })
  }, [rows, imageSearch, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleImageSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setImageSearch(e.target.value)
      setPage(1)
    },
    []
  )

  const toggleRow = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key))
  }, [])

  const COL_COUNT = 7

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Select
          value={severity}
          onValueChange={(v) => {
            if (v != null) { setSeverity(v as Severity | "all"); setPage(1) }
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("security.filter.allSeverities")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("security.filter.allSeverities")}</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`security.severity.${s.toLowerCase()}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={namespace}
          onValueChange={(v) => {
            if (v != null) { setNamespace(v); setPage(1) }
          }}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder={t("security.filter.allNamespaces")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("security.filter.allNamespaces")}</SelectItem>
            {allNamespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-56"
          placeholder={t("security.filter.image")}
          value={imageSearch}
          onChange={handleImageSearchChange}
        />

        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length > 0 &&
            `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length}`}
        </span>
      </div>

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="h-40 flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : pageRows.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
            {t("security.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground bg-muted/30">
                  <th className="px-3 py-3 w-8"></th>
                  <SortableHeader
                    label={t("security.table.namespace")}
                    sortKey="namespace"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={t("security.table.workload")}
                    sortKey="name"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={t("security.table.image")}
                    sortKey="image"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={t("security.severity.critical")}
                    sortKey="Critical"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={t("security.severity.high")}
                    sortKey="High"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="px-4 py-3 font-medium">{t("security.severity.medium")}</th>
                  <th className="px-4 py-3 font-medium">{t("security.severity.low")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const rowKey = `${row.namespace}|${row.kind}|${row.name}|${row.image}`
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
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-muted-foreground mr-1">{row.kind}</span>
                          <span className="font-medium">{row.name}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <code className="text-xs font-mono truncate max-w-[200px] block">{row.image}</code>
                        </td>
                        <td className="px-4 py-2.5">
                          <SeverityMini severity="Critical" count={row.summary.Critical} />
                        </td>
                        <td className="px-4 py-2.5">
                          <SeverityMini severity="High" count={row.summary.High} />
                        </td>
                        <td className="px-4 py-2.5">
                          <SeverityMini severity="Medium" count={row.summary.Medium} />
                        </td>
                        <td className="px-4 py-2.5">
                          <SeverityMini severity="Low" count={row.summary.Low} />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={COL_COUNT + 1} className="p-0">
                            <ExpandedVulnPanel image={row.image} />
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
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("security.pagination.prev")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("security.pagination.page")} {safePage}{" "}
            {t("security.pagination.of", { total: String(totalPages) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("security.pagination.next")}
          </Button>
        </div>
      )}
    </>
  )
}
