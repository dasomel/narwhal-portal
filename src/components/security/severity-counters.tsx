import { t } from "@/lib/i18n"
import type { Locale } from "@/lib/i18n"
import type { SecuritySummary } from "@/types/security"

interface Props {
  summary: SecuritySummary
  locale: Locale
}

const severityConfig = [
  { key: "Critical" as const, labelKey: "security.severity.critical" as const, color: "text-red-600", bg: "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900" },
  { key: "High" as const, labelKey: "security.severity.high" as const, color: "text-orange-500", bg: "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-900" },
  { key: "Medium" as const, labelKey: "security.severity.medium" as const, color: "text-amber-500", bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900" },
  { key: "Low" as const, labelKey: "security.severity.low" as const, color: "text-blue-500", bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900" },
  { key: "Unknown" as const, labelKey: "security.severity.unknown" as const, color: "text-gray-500", bg: "bg-gray-50 border-gray-200 dark:bg-gray-950/30 dark:border-gray-800" },
]

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

export function SeverityCounters({ summary, locale }: Props) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {severityConfig.map(({ key, labelKey, color, bg }) => (
          <div key={key} className={`rounded-lg border p-4 ${bg}`}>
            <div className={`text-2xl font-bold ${color}`}>{summary.totals[key] ?? 0}</div>
            <div className="text-xs font-medium text-muted-foreground mt-1">{t(locale, labelKey)}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <span>
          {t(locale, "security.summary.scannedImages")}: <span className="font-medium text-foreground">{summary.scannedImages}</span>
        </span>
        <span>
          {t(locale, "security.summary.scannedWorkloads")}: <span className="font-medium text-foreground">{summary.scannedWorkloads}</span>
        </span>
        <span>
          {t(locale, "security.summary.lastUpdated")}: <span className="font-medium text-foreground">{relativeTime(summary.lastUpdated, locale)}</span>
        </span>
      </div>
    </div>
  )
}
