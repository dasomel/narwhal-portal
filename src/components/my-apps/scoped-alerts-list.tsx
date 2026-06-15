"use client"

import { Card } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import type { MyAppsAlert } from "@/types/my-apps"

function RelativeTime({ iso }: { iso: string }) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  let label = "just now"
  if (days > 0) label = `${days}d ago`
  else if (hrs > 0) label = `${hrs}h ago`
  else if (mins > 0) label = `${mins}m ago`
  return <span className="font-mono text-xs text-muted-foreground">{label}</span>
}

function severityDot(severity: string): string {
  if (severity === "critical") return "bg-narwhal-danger"
  if (severity === "warning") return "bg-narwhal-warning"
  return "bg-narwhal-accent"
}

function severityText(severity: string): string {
  if (severity === "critical") return "text-narwhal-danger"
  if (severity === "warning") return "text-narwhal-warning"
  return "text-narwhal-accent"
}

interface ScopedAlertsListProps {
  alerts: MyAppsAlert[]
}

export function ScopedAlertsList({ alerts }: ScopedAlertsListProps) {
  const t = useT()

  return (
    <Card className="overflow-hidden" >
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-[13px] font-semibold text-foreground">{t("myApps.sections.alerts")}</h3>
      </div>
      {alerts.length === 0 ? (
        <div className="px-4 pb-4 text-[13px] text-muted-foreground">{t("alerts.none")}</div>
      ) : (
        <div className="divide-y divide-border">
          {alerts.map((alert, i) => {
            const severity = alert.labels.severity ?? "warning"
            const alertname = alert.labels.alertname ?? "Alert"
            const description = alert.annotations.description ?? alert.annotations.summary ?? ""
            return (
              <div key={i} className="px-4 py-3 flex items-start gap-3">
                <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${severityDot(severity)}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 justify-between">
                    <span className={`text-[12px] font-medium ${severityText(severity)}`}>{alertname}</span>
                    <RelativeTime iso={alert.startsAt} />
                  </div>
                  {description && (
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">{description}</div>
                  )}
                  {alert.labels.namespace && (
                    <div className="text-xs text-muted-foreground mt-0.5">ns: {alert.labels.namespace}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
