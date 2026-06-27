"use client"
import { useState, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT } from "@/lib/i18n-client"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { KisaResponse, KisaControl, KisaStatus } from "@/types/kisa"
import type { Severity } from "@/types/security"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

const statusBadgeClass: Record<KisaStatus, string> = {
  fail: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  manual: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  pass: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",
}

function SummaryBadge({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {label} <span className="font-bold">{count}</span>
    </span>
  )
}

function ExpandedPanel({ control }: { control: KisaControl }) {
  const t = useT()
  return (
    <div className="px-6 py-4 bg-muted/10 border-t border-dashed space-y-3 text-xs">
      <div>
        <p className="font-medium text-muted-foreground mb-1">{t("compliance.kisa.evidence")}</p>
        <p className="text-foreground">{control.evidence}</p>
      </div>
      {control.detail && (
        <div>
          <p className="font-medium text-muted-foreground mb-1">상태 상세</p>
          <p className="text-foreground">{control.detail}</p>
        </div>
      )}
      <div>
        <p className="font-medium text-muted-foreground mb-1">{t("compliance.kisa.remediation")}</p>
        <p className="text-foreground">{control.remediation}</p>
      </div>
      {!control.live && (
        <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-950/10 dark:border-amber-900 px-3 py-2">
          <p className="text-amber-700 dark:text-amber-400">{t("compliance.kisa.manualNote")}</p>
        </div>
      )}
    </div>
  )
}

export function KisaChecklist() {
  const t = useT()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<KisaResponse>({
    queryKey: ["compliance", "kisa"],
    queryFn: () => fetch("/api/compliance/kisa").then((r) => r.json()),
    staleTime: 60_000,
  })

  const toggleRow = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  if (isLoading) {
    return (
      <div className="h-40 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      </div>
    )
  }

  if (!data || data.controls.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
        {t("compliance.kisa.empty")}
      </div>
    )
  }

  const { controls, summary } = data

  return (
    <>
      {/* Summary row */}
      <div className="flex flex-wrap gap-2 mb-3">
        <SummaryBadge
          label="전체"
          count={summary.total}
          className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
        />
        <SummaryBadge
          label={t("compliance.kisa.status.fail")}
          count={summary.fail}
          className={statusBadgeClass.fail}
        />
        <SummaryBadge
          label={t("compliance.kisa.status.warn")}
          count={summary.warn}
          className={statusBadgeClass.warn}
        />
        <SummaryBadge
          label={t("compliance.kisa.status.manual")}
          count={summary.manual}
          className={statusBadgeClass.manual}
        />
        <SummaryBadge
          label={t("compliance.kisa.status.pass")}
          count={summary.pass}
          className={statusBadgeClass.pass}
        />
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted/30">
                <th className="px-3 py-3 w-8"></th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.id")}</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.domain")}</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.control")}</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.severity")}</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.status")}</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">{t("compliance.kisa.col.standards")}</th>
              </tr>
            </thead>
            <tbody>
              {controls.map((control) => {
                const isExpanded = expandedId === control.id
                return (
                  <>
                    <tr
                      key={control.id}
                      className="border-b hover:bg-muted/20 cursor-pointer transition-colors"
                      onClick={() => toggleRow(control.id)}
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
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {control.id}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {control.domain}
                      </td>
                      <td className="px-4 py-2.5 font-medium">{control.title}</td>
                      <td className="px-4 py-2.5">
                        <Badge className={`text-xs ${severityBadgeClass[control.severity] ?? severityBadgeClass.Unknown}`}>
                          {control.severity}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge className={`text-xs ${statusBadgeClass[control.status]}`}>
                          {t(`compliance.kisa.status.${control.status}` as Parameters<typeof t>[0])}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {control.standardRefs.join(", ")}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${control.id}__expand`}>
                        <td colSpan={7} className="p-0">
                          <ExpandedPanel control={control} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
