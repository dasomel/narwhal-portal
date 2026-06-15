"use client"

import { useState } from "react"
import { FilterChips, type FilterKey } from "@/components/live/filter-chips"
import { Narwhal } from "@/components/narwhal/narwhal"
import { useT } from "@/lib/i18n-client"
import type { LiveEvent, LiveSeverity } from "@/types/live"

interface LiveStreamProps {
  events: LiveEvent[]
  initialFilter?: FilterKey
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.floor(diffHr / 24)}d ago`
}

const severityStyles: Record<LiveSeverity, string> = {
  info: "bg-narwhal-accent/15 text-narwhal-accent border-narwhal-accent/30",
  success: "bg-narwhal-success/15 text-narwhal-success border-narwhal-success/30",
  warning: "bg-narwhal-warning/15 text-narwhal-warning border-narwhal-warning/30",
  error: "bg-narwhal-danger/15 text-narwhal-danger border-narwhal-danger/30",
}

function SeverityChip({ severity }: { severity: LiveSeverity }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${severityStyles[severity]}`}
    >
      {severity}
    </span>
  )
}

function EventRow({ event }: { event: LiveEvent }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground whitespace-nowrap mt-0.5 w-16 shrink-0">
        {relativeTime(event.timestamp)}
      </span>
      <SeverityChip severity={event.severity} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{event.title}</p>
        {event.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{event.description}</p>
        )}
        {event.links && event.links.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {event.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-narwhal-accent hover:text-narwhal-accent/80 underline"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground/40 shrink-0">{event.source}</span>
    </div>
  )
}

function filterEvents(events: LiveEvent[], filter: FilterKey): LiveEvent[] {
  switch (filter) {
    case "alerts":
      return events.filter((e) => e.type === "alert")
    case "deploys":
      return events.filter((e) => e.type === "deploy")
    case "syncs":
      return events.filter((e) => e.type === "sync")
    case "critical":
      return events.filter((e) => e.severity === "error")
    default:
      return events
  }
}

export function LiveStream({ events, initialFilter = "all" }: LiveStreamProps) {
  const [filter, setFilter] = useState<FilterKey>(initialFilter)
  const t = useT()

  const visible = filterEvents(events, filter)

  return (
    <div className="space-y-4">
      <FilterChips selected={filter} onChange={setFilter} />

      <div className="rounded-lg border bg-card">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4 text-muted-foreground">
            <Narwhal state="loading" size={80} />
            <p className="text-sm">{t("live.empty")}</p>
          </div>
        ) : (
          <div className="divide-y divide-border/50 px-4">
            {visible.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
