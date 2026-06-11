"use client"
import { useQuery } from "@tanstack/react-query"
import { useState, useMemo } from "react"
import { useSession } from "next-auth/react"
import { Table2, Grid3X3, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import { RbacGraph } from "./rbac-graph"
import type { RbacResponseV2, RbacBindingV2, RbacRisk } from "./types"

type ScopeFilter = "all" | "cluster" | "namespace"
type SortKey = "name" | "scope" | "role" | "subjects" | "risk"

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onToggle,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: "asc" | "desc"
  onToggle: (key: SortKey) => void
}) {
  const active = current === sortKey
  return (
    <th
      className="pb-2 font-medium cursor-pointer select-none whitespace-nowrap"
      onClick={() => onToggle(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp className="w-3 h-3 text-foreground" />
          ) : (
            <ChevronDown className="w-3 h-3 text-foreground" />
          )
        ) : (
          <ChevronsUpDown className="w-3 h-3 text-muted-foreground/40" />
        )}
      </span>
    </th>
  )
}

const riskPriority: Record<RbacRisk, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

const riskBadgeClass: Record<RbacRisk, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400 border-red-200/30",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400 border-orange-200/30",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 border-amber-200/30",
  low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400 border-blue-200/30",
}

export function RbacTable() {
  const t = useT()
  const { data: session } = useSession()
  const role = session?.user?.role ?? "guest"
  const [filter, setFilter] = useState<ScopeFilter>("all")
  const [riskFilter, setRiskFilter] = useState<RbacRisk | "all">("all")
  const [viewMode, setViewMode] = useState<"table" | "graph">("table")
  const [sortKey, setSortKey] = useState<SortKey>("risk")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const { data, isLoading } = useQuery<RbacResponseV2>({
    queryKey: ["governance-rbac"],
    queryFn: () => fetch("/api/governance/rbac").then((r) => r.json()),
    refetchInterval: 30_000,
    enabled: role === "cluster-admin",
  })

  if (role !== "cluster-admin") {
    return (
      <Card className="p-5">
        <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">
          {t("rbac.forbidden")}
        </div>
      </Card>
    )
  }

  const bindings = data?.bindings ?? []
  const summary = data?.summary ?? {
    total: 0,
    clusterScope: 0,
    namespaceScope: 0,
    bySubjectKind: { user: 0, group: 0, serviceAccount: 0 },
    byRisk: { critical: 0, high: 0, medium: 0, low: 0 }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "risk" ? "desc" : "asc")
    }
  }

  const filtered = bindings.filter(
    (b) =>
      (filter === "all" || b.scope === filter) &&
      (riskFilter === "all" || b.risk === riskFilter)
  )

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0
      if (sortKey === "risk") {
        cmp = riskPriority[a.risk] - riskPriority[b.risk]
      } else if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name)
      } else if (sortKey === "scope") {
        cmp = a.scope.localeCompare(b.scope)
      } else if (sortKey === "role") {
        cmp = a.roleRef.name.localeCompare(b.roleRef.name)
      } else if (sortKey === "subjects") {
        const aVal = a.subjects[0]?.name ?? ""
        const bVal = b.subjects[0]?.name ?? ""
        cmp = a.subjects.length !== b.subjects.length
          ? a.subjects.length - b.subjects.length
          : aVal.localeCompare(bVal)
      }
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  const getTranslatedReason = (reason: string) => {
    const key = `rbac.reason.${reason}` as any
    const val = t(key)
    return val === key ? reason : val
  }

  const statCards = [
    { label: t("rbac.summary.total"), value: summary.total, color: "text-foreground", bg: "bg-card border-border" },
    { label: t("rbac.summary.clusterScope"), value: summary.clusterScope, color: "text-purple-600 dark:text-purple-400", bg: "bg-purple-50 border-purple-200 dark:bg-purple-950/30 dark:border-purple-900" },
    { label: t("rbac.risk.critical"), value: summary.byRisk.critical, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900" },
    { label: t("rbac.risk.high"), value: summary.byRisk.high, color: "text-orange-500 dark:text-orange-400", bg: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-900" },
    { label: t("rbac.risk.medium"), value: summary.byRisk.medium, color: "text-amber-500 dark:text-amber-400", bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900" },
    { label: t("rbac.risk.low"), value: summary.byRisk.low, color: "text-blue-500 dark:text-blue-400", bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900" },
  ]

  return (
    <div className="space-y-4">
      {/* 6 Summary Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((card, idx) => (
          <div key={idx} className={`rounded-lg border p-4 ${card.bg}`}>
            <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-xs font-medium text-muted-foreground mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      <Card className="p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <h2 className="font-semibold text-foreground">{t("rbac.title")}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {/* Scope Filters */}
            <div className="flex gap-1">
              {(["all", "cluster", "namespace"] as ScopeFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    filter === s
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {s === "all" ? t("rbac.filterAll") : s === "cluster" ? t("rbac.filterCluster") : t("rbac.filterNamespace")}
                </button>
              ))}
            </div>
            
            <div className="w-px h-4 bg-border hidden sm:block" />

            {/* Risk Filters */}
            <div className="flex gap-1">
              {(["all", "critical", "high", "medium", "low"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRiskFilter(r)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    riskFilter === r
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {r === "all" ? t("rbac.risk.all") : t(`rbac.risk.${r}`)}
                </button>
              ))}
            </div>

            <div className="w-px h-4 bg-border" />

            <div className="flex items-center gap-2">
              <button onClick={() => setViewMode("table")} title="Table">
                <Table2 className={`w-4 h-4 ${viewMode === "table" ? "text-foreground" : "text-muted-foreground hover:text-muted-foreground"}`} />
              </button>
              <button onClick={() => setViewMode("graph")} title="Matrix">
                <Grid3X3 className={`w-4 h-4 ${viewMode === "graph" ? "text-foreground" : "text-muted-foreground hover:text-muted-foreground"}`} />
              </button>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
            <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
            <span className="text-sm text-muted-foreground">{t("rbac.empty")}</span>
          </div>
        ) : viewMode === "graph" ? (
          <RbacGraph key={`${filter}-${riskFilter}`} bindings={filtered} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <SortHeader label={t("rbac.risk")} sortKey="risk" current={sortKey} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader label={t("rbac.binding")} sortKey="name" current={sortKey} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader label={t("rbac.scope")} sortKey="scope" current={sortKey} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader label={t("rbac.role")} sortKey="role" current={sortKey} dir={sortDir} onToggle={toggleSort} />
                  <th className="pb-2 font-medium text-left text-muted-foreground text-xs whitespace-nowrap">{t("rbac.rules")}</th>
                  <SortHeader label={t("rbac.subjects")} sortKey="subjects" current={sortKey} dir={sortDir} onToggle={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={`${b.scope}-${b.namespace ?? "cluster"}-${b.name}`} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="py-2.5">
                      <Badge
                        className={`${riskBadgeClass[b.risk]} capitalize text-[10px] font-semibold px-2 py-0.5 border cursor-help`}
                        title={b.riskReasons.map(getTranslatedReason).join(", ") || t("rbac.reason.read-only")}
                      >
                        {t(`rbac.risk.${b.risk}`)}
                      </Badge>
                    </td>
                    <td className="py-2.5 font-mono text-xs text-foreground">{b.name}</td>
                    <td className="py-2.5">
                      <Badge
                        className={
                          b.scope === "cluster"
                            ? "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/20"
                            : "bg-narwhal-accent/15 text-narwhal-accent border-narwhal-accent/20"
                        }
                      >
                        {b.scope === "cluster" ? t("rbac.cluster") : t("rbac.namespace")}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-foreground">{b.roleRef.name}</td>
                    <td className="py-2.5">
                      {b.ruleSummary ? (
                        <div className="flex flex-wrap gap-1 items-center">
                          <span className="text-xs text-muted-foreground font-mono mr-1" title={t("rbac.ruleCount", { count: b.ruleSummary.ruleCount })}>
                            R{b.ruleSummary.ruleCount}
                          </span>
                          {(b.ruleSummary.wildcardVerbs || b.ruleSummary.wildcardResources) && (
                            <Badge variant="outline" className="text-[10px] font-mono px-1 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" title={t("rbac.wildcard")}>
                              *
                            </Badge>
                          )}
                          {b.ruleSummary.secretsAccess && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0.5 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20" title={t("rbac.secretsAccess")}>
                              secrets
                            </Badge>
                          )}
                          {b.ruleSummary.writeAccess && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20" title={t("rbac.writeAccess")}>
                              write
                            </Badge>
                          )}
                          {b.ruleSummary.escalation && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0.5 bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 animate-pulse font-semibold" title={t("rbac.escalation")}>
                              escalate
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-muted-foreground text-xs">
                      {b.subjects.map((s) => s.name).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
