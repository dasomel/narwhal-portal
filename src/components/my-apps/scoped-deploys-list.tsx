"use client"

import { Card } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import type { TimelineEvent } from "@/app/api/events/route"

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

function severityDot(severity: TimelineEvent["severity"]): string {
  if (severity === "error") return "bg-narwhal-danger"
  if (severity === "warning") return "bg-narwhal-warning"
  if (severity === "success") return "bg-narwhal-success"
  return "bg-narwhal-accent"
}

interface ScopedDeploysListProps {
  events: TimelineEvent[]
}

export function ScopedDeploysList({ events }: ScopedDeploysListProps) {
  const t = useT()
  const deploys = events.filter((e) => e.type === "deploy")

  return (
    <Card className="overflow-hidden" >
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-[13px] font-semibold text-foreground">{t("myApps.sections.deploys")}</h3>
      </div>
      {deploys.length === 0 ? (
        <div className="px-4 pb-4 text-[13px] text-muted-foreground">{t("events.empty")}</div>
      ) : (
        <div className="divide-y divide-border">
          {deploys.slice(0, 20).map((event) => (
            <div key={event.id} className="px-4 py-3 flex items-start gap-3">
              <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${severityDot(event.severity)}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 justify-between">
                  <span className="text-[12px] font-medium text-foreground">{event.title}</span>
                  <RelativeTime iso={event.timestamp} />
                </div>
                {event.description && (
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">{event.description}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
