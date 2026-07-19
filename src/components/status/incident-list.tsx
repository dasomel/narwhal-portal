"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import { incidentSeverityClass } from "./status-colors"
import type { StatusIncident } from "@/types/api"
import type { TranslationKey } from "@/lib/i18n"

const severityLabelKey: Record<StatusIncident["severity"], TranslationKey> = {
  critical: "status.incidents.severity.critical",
  warning: "status.incidents.severity.warning",
}

function relativeTime(iso: string, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t("audit.justNow")
  if (mins < 60) return t("audit.minsAgo", { mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("audit.hrsAgo", { hrs })
  return t("audit.daysAgo", { days: Math.floor(hrs / 24) })
}

export function IncidentList({ incidents }: { incidents: StatusIncident[] }) {
  const t = useT()

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-foreground mb-3">{t("status.incidents.title")}</h2>
      {incidents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("status.incidents.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {incidents.map((incident) => (
            <li key={incident.id} className="flex items-start gap-3">
              <Badge className={`text-xs shrink-0 mt-0.5 ${incidentSeverityClass[incident.severity]}`}>
                {t(severityLabelKey[incident.severity])}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-foreground">{incident.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {incident.component ?? t("status.incidents.componentNone")}
                  </span>
                  <span className="text-xs text-muted-foreground/70">
                    {relativeTime(incident.startsAt, t)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{incident.summary}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
