"use client"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { translateTitle } from "@/lib/check-translations"
import { Badge } from "@/components/ui/badge"
import type { ComplianceFramework, ComplianceFrameworkDetail, Severity } from "@/types/compliance"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

function PassRateBar({ rate }: { rate: number }) {
  const pct = Math.min(100, Math.max(0, rate))
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500"
  return (
    <div className="w-full bg-muted rounded-full h-2 mt-2">
      <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function ExpandedFrameworkPanel({ id }: { id: string }) {
  const t = useT()
  const locale = useLocale()

  const { data: detail, isLoading } = useQuery<ComplianceFrameworkDetail>({
    queryKey: ["compliance-framework-detail", id],
    queryFn: () =>
      fetch(`/api/compliance/frameworks?id=${encodeURIComponent(id)}`).then((r) => r.json()),
    enabled: true,
    staleTime: 60_000,
  })

  const top5 = detail?.controls
    ? (() => {
        const order: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]
        return [...detail.controls]
          .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
          .slice(0, 5)
      })()
    : []

  return (
    <div className="mt-3 pt-3 border-t border-dashed space-y-2">
      {isLoading ? (
        <span className="text-xs text-muted-foreground animate-pulse">{t("common.loading")}</span>
      ) : detail ? (
        <>
          {top5.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t("common.notFound")}</span>
          ) : (
            top5.map((ctrl) => (
              <div key={ctrl.id} className="rounded-md border bg-card p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground">{ctrl.id}</span>
                  <Badge className={`text-xs ${severityBadgeClass[ctrl.severity] ?? severityBadgeClass.Unknown}`}>
                    {ctrl.severity}
                  </Badge>
                </div>
                <p className="mt-1 font-medium text-foreground">{id.startsWith("k8s-cis") ? translateTitle("cis", ctrl.id, ctrl.name, locale) : ctrl.name}</p>
                <div className="flex items-center gap-3 mt-1 text-muted-foreground">
                  <span className="text-green-600 font-medium">✓ {ctrl.passCount}</span>
                  <span className="text-red-600 font-medium">✗ {ctrl.failCount}</span>
                </div>
              </div>
            ))
          )}
          <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href={`/compliance/frameworks/${encodeURIComponent(id)}`}>
              {t("common.viewFullDetails")}
            </a>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{t("common.notFound")}</span>
      )}
    </div>
  )
}

export function FrameworksGrid() {
  const t = useT()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: frameworks = [], isLoading } = useQuery<ComplianceFramework[]>({
    queryKey: ["compliance-frameworks"],
    queryFn: () => fetch("/api/compliance/frameworks").then((r) => r.json()),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="h-40 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      </div>
    )
  }

  if (frameworks.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
        {t("compliance.empty")}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {frameworks.map((fw) => {
        const isExpanded = expandedId === fw.id
        return (
          <div key={fw.id} className="rounded-lg border bg-card p-4">
            <button
              className="w-full text-left"
              onClick={() => setExpandedId((prev) => (prev === fw.id ? null : fw.id))}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm">{fw.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("compliance.framework.controls", { count: fw.totalControls })}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-sm font-bold ${
                      fw.passRate >= 0.8
                        ? "text-green-600"
                        : fw.passRate >= 0.5
                        ? "text-amber-600"
                        : "text-red-600"
                    }`}
                  >
                    {Math.round(fw.passRate * 100)}%
                  </span>
                  <span
                    className="text-muted-foreground text-sm inline-block transition-transform duration-200"
                    style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                    title={isExpanded ? t("common.collapse") : t("common.expand")}
                  >
                    ›
                  </span>
                </div>
              </div>
              <PassRateBar rate={fw.passRate * 100} />
              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                <span className="text-green-600 font-medium">✓ {fw.passCount}</span>
                <span className="text-red-600 font-medium">✗ {fw.failCount}</span>
              </div>
            </button>

            {isExpanded && <ExpandedFrameworkPanel id={fw.id} />}
          </div>
        )
      })}
    </div>
  )
}
