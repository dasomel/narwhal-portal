import { t } from "@/lib/i18n"
import type { Locale } from "@/lib/i18n"
import type { ComplianceSummary } from "@/types/compliance"

interface Props {
  summary: ComplianceSummary
  locale: Locale
}

function relativeTime(iso: string, locale: Locale): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t(locale, "audit.justNow")
  if (mins < 60) return t(locale, "audit.minsAgo", { mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t(locale, "audit.hrsAgo", { hrs })
  const days = Math.floor(hrs / 24)
  return t(locale, "audit.daysAgo", { days })
}

function avgPassRate(frameworks: ComplianceSummary["frameworks"]): number {
  if (!frameworks.length) return 0
  const sum = frameworks.reduce((acc, f) => acc + f.passRate, 0)
  return Math.round(sum / frameworks.length)
}

const counterConfig = [
  {
    key: "configAudit" as const,
    labelKey: "compliance.counter.configAudit" as const,
    bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900",
    color: "text-red-600",
  },
  {
    key: "rbac" as const,
    labelKey: "compliance.counter.rbac" as const,
    bg: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-900",
    color: "text-orange-500",
  },
  {
    key: "infra" as const,
    labelKey: "compliance.counter.infra" as const,
    bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900",
    color: "text-amber-500",
  },
  {
    key: "frameworks" as const,
    labelKey: "compliance.counter.frameworksPassRate" as const,
    bg: "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-900",
    color: "text-green-600",
  },
]

export function FailureCounters({ summary, locale }: Props) {
  const passRate = avgPassRate(summary.frameworks)
  const acceptedSystemTotal =
    (summary.acceptedSystemConfigAuditFailures?.Critical ?? 0) +
    (summary.acceptedSystemConfigAuditFailures?.High ?? 0) +
    (summary.acceptedSystemConfigAuditFailures?.Medium ?? 0) +
    (summary.acceptedSystemConfigAuditFailures?.Low ?? 0)
  const lowSeverityTotal = summary.lowSeverityConfigAuditFailures?.Low ?? 0
  const acceptedRbacTotal =
    (summary.acceptedRbacFailures?.Critical ?? 0) +
    (summary.acceptedRbacFailures?.High ?? 0) +
    (summary.acceptedRbacFailures?.Medium ?? 0) +
    (summary.acceptedRbacFailures?.Low ?? 0)

  const values: Record<(typeof counterConfig)[number]["key"], string> = {
    configAudit: String(
      (summary.totalConfigAuditFailures.Critical ?? 0) +
        (summary.totalConfigAuditFailures.High ?? 0) +
        (summary.totalConfigAuditFailures.Medium ?? 0) +
        (summary.totalConfigAuditFailures.Low ?? 0)
    ),
    rbac: String(
      (summary.totalRbacFailures.Critical ?? 0) +
        (summary.totalRbacFailures.High ?? 0) +
        (summary.totalRbacFailures.Medium ?? 0) +
        (summary.totalRbacFailures.Low ?? 0)
    ),
    infra: String(
      (summary.totalInfraFailures.Critical ?? 0) +
        (summary.totalInfraFailures.High ?? 0) +
        (summary.totalInfraFailures.Medium ?? 0) +
        (summary.totalInfraFailures.Low ?? 0)
    ),
    frameworks: `${passRate}%`,
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {counterConfig.map(({ key, labelKey, bg, color }) => (
          <div key={key} className={`rounded-lg border p-4 ${bg}`}>
            <div className={`text-2xl font-bold ${color}`}>{values[key]}</div>
            <div className="text-xs font-medium text-muted-foreground mt-1">{t(locale, labelKey)}</div>
            {key === "configAudit" && (lowSeverityTotal > 0 || acceptedSystemTotal > 0) && (
              <div className="text-[0.7rem] text-muted-foreground/70 mt-0.5">
                {t(locale, "compliance.counter.configAuditBreakdown", {
                  low: String(lowSeverityTotal),
                  accepted: String(acceptedSystemTotal),
                })}
              </div>
            )}
            {key === "rbac" && acceptedRbacTotal > 0 && (
              <div className="text-[0.7rem] text-muted-foreground/70 mt-0.5">
                {t(locale, "compliance.counter.rbacBreakdown", {
                  accepted: String(acceptedRbacTotal),
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-6 text-xs text-muted-foreground">
        <span>
          {t(locale, "compliance.summary.scannedWorkloads")}:{" "}
          <span className="font-medium text-foreground">{summary.scannedWorkloads}</span>
        </span>
        <span>
          {t(locale, "compliance.summary.scannedRbacObjects")}:{" "}
          <span className="font-medium text-foreground">{summary.scannedRbacObjects}</span>
        </span>
        <span>
          {t(locale, "compliance.summary.scannedNodes")}:{" "}
          <span className="font-medium text-foreground">{summary.scannedNodes}</span>
        </span>
        <span>
          {t(locale, "compliance.summary.lastUpdated")}:{" "}
          <span className="font-medium text-foreground">{relativeTime(summary.lastUpdated, locale)}</span>
        </span>
      </div>
    </div>
  )
}
