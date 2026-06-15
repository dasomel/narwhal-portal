"use client"
// TODO(wrap-up): i18n keys for ko/en — see spec §5.7

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useT, useLocale } from "@/lib/i18n-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ScorecardListResponse } from "@/app/api/scorecards/route"
import type { ScorecardRulesResponse } from "@/app/api/scorecards/rules/route"

// ---------------------------------------------------------------------------
// Tier badge
// ---------------------------------------------------------------------------

const TIER_COLORS: Record<string, string> = {
  gold: "bg-yellow-100 text-yellow-800 border-yellow-300",
  silver: "bg-gray-100 text-gray-700 border-gray-300",
  bronze: "bg-orange-100 text-orange-700 border-orange-300",
  none: "bg-muted text-muted-foreground border-border",
}

function TierBadge({ tier }: { tier: string }) {
  const t = useT()
  const label = tier === "none" ? `— ${t("scorecard.tier.none")}` : (tier === "gold" ? "🥇 Gold" : (tier === "silver" ? "🥈 Silver" : "🥉 Bronze"))
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${TIER_COLORS[tier] ?? TIER_COLORS.none}`}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Donut chart (CSS conic-gradient — no extra dep)
// ---------------------------------------------------------------------------

function DonutChart({ counts, t }: { counts: { gold: number; silver: number; bronze: number; none: number }; t: ReturnType<typeof useT> }) {
  const total = counts.gold + counts.silver + counts.bronze + counts.none
  if (total === 0) return <div className="w-32 h-32 rounded-full bg-muted" />

  const pct = (n: number) => (n / total) * 100
  const g = pct(counts.gold)
  const s = pct(counts.silver)
  const b = pct(counts.bronze)
  // none fills the rest

  const gradient = `conic-gradient(
    #ca8a04 0% ${g}%,
    #9ca3af ${g}% ${g + s}%,
    #ea580c ${g + s}% ${g + s + b}%,
    #e5e7eb ${g + s + b}% 100%
  )`

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="w-32 h-32 rounded-full"
        style={{ background: gradient }}
        role="img"
        aria-label={t("scorecard.distribution")}
      >
        <div className="w-full h-full rounded-full flex items-center justify-center"
          style={{ margin: "12px", width: "calc(100% - 24px)", height: "calc(100% - 24px)", background: "var(--background)", borderRadius: "50%" }}
        >
          <span className="text-lg font-bold">{total}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-600 inline-block" /><span>Gold {counts.gold}</span></div>
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" /><span>Silver {counts.silver}</span></div>
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-600 inline-block" /><span>Bronze {counts.bronze}</span></div>
        <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-200 inline-block border" /><span>{t("scorecard.tier.none")} {counts.none}</span></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rules modal
// ---------------------------------------------------------------------------

function RulesModal() {
  const t = useT()
  const { data, isLoading } = useQuery<ScorecardRulesResponse>({
    queryKey: ["scorecard-rules"],
    queryFn: () => fetch("/api/scorecards/rules").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <Dialog>
      <DialogTrigger className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
        {t("scorecard.viewRulesShort")}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("scorecard.rulesTitle")}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <p className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</p>
        )}
        {data?.rawYaml && (
          <pre className="text-xs bg-muted p-4 rounded overflow-x-auto whitespace-pre-wrap">
            {data.rawYaml}
          </pre>
        )}
        {data && !data.rawYaml && (
          <div className="space-y-2">
            {(data.rules as Array<{ id: string; name: string; weight: number }>).map((r) => (
              <div key={r.id} className="flex justify-between text-sm border-b pb-1">
                <span>{r.name}</span>
                <span className="text-muted-foreground">{r.weight}pt</span>
              </div>
            ))}
          </div>
        )}
        {!isLoading && !data && (
          <p className="text-sm text-destructive">{t("scorecard.noConfigMap")}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function downloadCSV(data: ScorecardListResponse, t: ReturnType<typeof useT>) {
  const header = [
    t("csv.id"),
    t("csv.name"),
    t("csv.namespace"),
    t("csv.owner"),
    t("csv.score"),
    t("csv.tier"),
    t("csv.failedRules"),
  ]
  const rows = data.services.map((s) => [
    s.id,
    s.name,
    s.namespace,
    s.owner ?? "",
    s.score,
    s.tier,
    s.failedRuleIds.join("|"),
  ])
  const csv = [header, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `scorecards-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ScorecardsTable() {
  const router = useRouter()
  const t = useT()
  const locale = useLocale()
  const [tierFilter, setTierFilter] = useState<string>("all")
  const [ownerFilter, setOwnerFilter] = useState<string>("all")
  const [search, setSearch] = useState("")
  const [sortBy, setSortBy] = useState<"score-desc" | "score-asc" | "name">("score-desc")

  const queryKey = ["scorecards", tierFilter, ownerFilter]
  const { data, isLoading, error } = useQuery<ScorecardListResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams()
      if (tierFilter !== "all") params.set("tier", tierFilter)
      if (ownerFilter !== "all") params.set("owner", ownerFilter)
      return fetch(`/api/scorecards?${params}`).then((r) => r.json())
    },
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="h-48 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("scorecard.evaluating")}</span>
      </div>
    )
  }

  if (error || (data && "error" in data)) {
    const msg = (data as { message?: string })?.message
    return (
      <Card className="border-destructive">
        <CardContent className="pt-4">
          <p className="text-sm text-destructive">
            {msg ?? t("scorecard.loadErrorConfigMap")}
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  // Unique owners for filter
  const owners = Array.from(new Set(data.services.map((s) => s.owner).filter(Boolean))) as string[]

  // Filter + sort
  let services = data.services.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  if (sortBy === "score-desc") services = [...services].sort((a, b) => b.score - a.score)
  else if (sortBy === "score-asc") services = [...services].sort((a, b) => a.score - b.score)
  else services = [...services].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="space-y-6">
      {/* Distribution + header */}
      <div className="flex flex-col sm:flex-row gap-6 items-start">
        <DonutChart counts={data.tierCounts} t={t} />
        <div className="flex-1 space-y-1">
          <h2 className="text-lg font-semibold">{t("scorecard.qualityScore")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("scorecard.summaryText", {
              total: data.totalServices,
              version: data.rulesVersion,
              date: new Date(data.evaluatedAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US"),
            })}
          </p>
          <div className="flex gap-2 mt-3">
            <RulesModal />
            <button
              onClick={() => downloadCSV(data, t)}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {t("scorecard.exportCsv")}
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder={t("scorecard.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border rounded px-3 py-1 text-sm bg-background w-48"
        />
        <Select value={tierFilter} onValueChange={(v) => setTierFilter(v ?? "all")}>
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue placeholder={t("scorecard.tierFilter")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("scorecard.allTiers")}</SelectItem>
            <SelectItem value="gold">Gold</SelectItem>
            <SelectItem value="silver">Silver</SelectItem>
            <SelectItem value="bronze">Bronze</SelectItem>
            <SelectItem value="none">{t("scorecard.tier.none")}</SelectItem>
          </SelectContent>
        </Select>
        {owners.length > 0 && (
          <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v ?? "all")}>
            <SelectTrigger className="w-40 h-8 text-sm">
              <SelectValue placeholder={t("scorecard.ownerFilter")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("scorecard.allOwners")}</SelectItem>
              {owners.map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sortBy} onValueChange={(v) => setSortBy((v ?? "score-desc") as typeof sortBy)}>
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue placeholder={t("scorecard.sort")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="score-desc">{t("scorecard.sort.scoreDesc")}</SelectItem>
            <SelectItem value="score-asc">{t("scorecard.sort.scoreAsc")}</SelectItem>
            <SelectItem value="name">{t("scorecard.sort.name")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t("scorecard.servicesCount", { count: services.length })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tier</TableHead>
                <TableHead>{t("scorecard.service")}</TableHead>
                <TableHead className="text-right">{t("scorecard.score")}</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>{t("scorecard.failedRulesCol")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {t("scorecard.noResults")}
                  </TableCell>
                </TableRow>
              )}
              {services.map((svc) => (
                <TableRow
                  key={svc.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => router.push(`/catalog/${svc.id}?tab=quality`)}
                >
                  <TableCell><TierBadge tier={svc.tier} /></TableCell>
                  <TableCell>
                    <div className="font-medium">{svc.name}</div>
                    <div className="text-xs text-muted-foreground">{svc.namespace}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    {svc.score}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {svc.owner ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {svc.failedRuleIds.slice(0, 3).map((id) => (
                        <Badge key={id} variant="outline" className="text-xs text-destructive border-destructive/40">
                          {id}
                        </Badge>
                      ))}
                      {svc.failedRuleIds.length > 3 && (
                        <span className="text-xs text-muted-foreground">+{svc.failedRuleIds.length - 3}</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
