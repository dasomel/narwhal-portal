"use client"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { translateTitle, translateRemediation } from "@/lib/check-translations"
import { Badge } from "@/components/ui/badge"
import type { InfraAuditRow, InfraAuditDetail, Severity } from "@/types/compliance"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

function totalFailures(summary: InfraAuditRow["summary"]): number {
  return (summary.Critical ?? 0) + (summary.High ?? 0) + (summary.Medium ?? 0) + (summary.Low ?? 0)
}

function ExpandedInfraPanel({ node }: { node: string }) {
  const t = useT()
  const locale = useLocale()

  const { data: detail, isLoading } = useQuery<InfraAuditDetail>({
    queryKey: ["compliance-infra-detail", node],
    queryFn: () =>
      fetch(`/api/compliance/infra-audit?node=${encodeURIComponent(node)}`).then((r) => r.json()),
    enabled: true,
    staleTime: 60_000,
  })

  const top5Failed = detail?.checks
    ? (() => {
        const order: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]
        return detail.checks
          .filter((c) => !c.success)
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
          {top5Failed.length === 0 ? (
            <div className="rounded-md border border-green-200 bg-green-50/60 dark:bg-green-950/10 dark:border-green-900 p-3 text-xs">
              <p className="font-medium text-green-700 dark:text-green-400">✓ {t("compliance.check.allPassed")}</p>
              <p className="text-muted-foreground mt-1">{t("compliance.check.allPassedHint")}</p>
            </div>
          ) : (
            <>
              {top5Failed.map((check) => (
                <div
                  key={check.id}
                  className="rounded-md border border-red-200 bg-red-50/60 dark:bg-red-950/10 dark:border-red-900 p-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{check.id}</span>
                    <Badge className={`text-xs ${severityBadgeClass[check.severity] ?? severityBadgeClass.Unknown}`}>
                      {check.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 font-medium text-foreground">{translateTitle("ksv", check.id, check.title, locale)}</p>
                  {check.remediation && (
                    <p className="mt-0.5 text-muted-foreground line-clamp-2">{translateRemediation("ksv", check.id, check.remediation, locale)}</p>
                  )}
                </div>
              ))}
              <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href={`/compliance/infra-audit/${encodeURIComponent(node)}`}>
                  {t("common.viewFullDetails")}
                </a>
            </>
          )}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{t("common.notFound")}</span>
      )}
    </div>
  )
}

export function InfraAuditList() {
  const t = useT()
  const [expandedNode, setExpandedNode] = useState<string | null>(null)

  const { data: rows = [], isLoading } = useQuery<InfraAuditRow[]>({
    queryKey: ["compliance-infra-audit"],
    queryFn: () => fetch("/api/compliance/infra-audit").then((r) => r.json()),
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="h-40 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
        {t("compliance.empty")}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {rows.map((row) => {
        const failures = totalFailures(row.summary)
        const hasIssues = failures > 0
        const isExpanded = expandedNode === row.node

        return (
          <div
            key={row.node}
            className={`rounded-lg border p-4 transition-colors ${
              hasIssues
                ? "border-orange-200 bg-orange-50/50 dark:bg-orange-950/10 dark:border-orange-900"
                : "border-green-200 bg-green-50/50 dark:bg-green-950/10 dark:border-green-900"
            }`}
          >
            <button
              className="w-full text-left"
              onClick={() => setExpandedNode((prev) => (prev === row.node ? null : row.node))}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-sm">{row.node}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${hasIssues ? "text-orange-600" : "text-green-600"}`}>
                    {hasIssues ? `${failures} issues` : "Clean"}
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
              <div className="flex flex-wrap gap-1.5">
                {(["Critical", "High", "Medium", "Low"] as const).map((s) =>
                  row.summary[s] > 0 ? (
                    <span
                      key={s}
                      className={`text-xs px-1.5 py-0.5 rounded font-medium ${severityBadgeClass[s]}`}
                    >
                      {s}: {row.summary[s]}
                    </span>
                  ) : null
                )}
              </div>
            </button>

            {isExpanded && <ExpandedInfraPanel node={row.node} />}
          </div>
        )
      })}
    </div>
  )
}
