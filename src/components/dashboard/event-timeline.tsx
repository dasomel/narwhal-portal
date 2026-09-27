// @deprecated — see docs/superpowers/specs/2026-04-17-dashboard-narwhal-redesign-design.md §5.3
// Merged into ActivityFeed (unified alert+event stream). Delete after Phase A validation.
"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DataState } from "@/components/ui/data-state"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useT, useLocale } from "@/lib/i18n-client"
import type { Locale } from "@/lib/i18n"
import type { TimelineEvent } from "@/app/api/events/route"

const severityStyle: Record<string, string> = {
  success: "bg-narwhal-success",
  info: "bg-narwhal-accent",
  warning: "bg-narwhal-warning",
  error: "bg-narwhal-danger",
}

const severityBadgeClass: Record<string, string> = {
  success: "bg-narwhal-success/15 text-narwhal-success border-narwhal-success/30",
  info: "bg-narwhal-accent/15 text-narwhal-accent border-narwhal-accent/30",
  warning: "bg-narwhal-warning/15 text-narwhal-warning border-narwhal-warning/30",
  error: "bg-narwhal-danger/15 text-narwhal-danger border-narwhal-danger/30",
}

const typeLabel: Record<string, string> = {
  deploy: "Deploy",
  sync: "Sync",
  alert: "Alert",
}

function relativeTime(dateStr: string, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t("events.relative.justNow")
  if (mins < 60) return t("events.relative.minutesAgo", { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t("events.relative.hoursAgo", { n: hours })
  return t("events.relative.daysAgo", { n: Math.floor(hours / 24) })
}

function formatOccurrenceTime(dateStr: string, locale: Locale): string {
  return new Date(dateStr).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatFullTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function EventTimeline() {
  const t = useT()
  const locale = useLocale()
  const [selected, setSelected] = useState<TimelineEvent | null>(null)

  const { data: events, isLoading, isError, refetch } = useQuery<TimelineEvent[]>({
    queryKey: ["events"],
    queryFn: () => fetch("/api/events").then((r) => r.json()),
    refetchInterval: 15_000,
  })

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-foreground">{t("events.title")}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading && !events ? (
            <DataState state="loading" onRetry={() => { void refetch() }} />
          ) : isError && !events ? (
            <DataState state="unavailable" onRetry={() => { void refetch() }} />
          ) : !events || events.length === 0 ? (
            isError ? <DataState state="unavailable" onRetry={() => { void refetch() }} /> : <DataState state="empty" />
          ) : (
            <div className="space-y-2">
              {isError && <DataState state="stale" onRetry={() => { void refetch() }} />}
              <div className="space-y-0 max-h-[400px] overflow-y-auto">
              {events.slice(0, 20).map((evt) => (
                <button
                  key={evt.id}
                  type="button"
                  aria-labelledby={`${evt.id}-title ${evt.id}-type ${evt.id}-description ${evt.id}-time`}
                  className="flex w-full text-left gap-3 py-2 border-b border-border last:border-0 hover:bg-muted/50 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setSelected(evt)}
                >
                  <div className="flex flex-col items-center pt-1">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${severityStyle[evt.severity]}`} />
                    <span className="w-px flex-1 bg-border mt-1" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span id={`${evt.id}-title`} className="text-xs font-medium text-foreground truncate">{evt.title}</span>
                      <Badge id={`${evt.id}-type`} variant="outline" className="text-[9px] shrink-0">
                        {typeLabel[evt.type] ?? evt.type}
                      </Badge>
                    </div>
                    <p id={`${evt.id}-description`} className="text-xs text-muted-foreground truncate mt-0.5">{evt.description}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                      <span id={`${evt.id}-time`} className="tabular-nums">{formatOccurrenceTime(evt.timestamp, locale)}</span>
                      <span className="text-border">·</span>
                      <span>{relativeTime(evt.timestamp, t)}</span>
                    </div>
                  </div>
                </button>
              ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full max-w-md overflow-y-auto overflow-x-hidden">
          {selected && (
            <>
              <SheetHeader className="mb-2 px-0">
                <SheetTitle className="text-base leading-snug break-words">{selected.title}</SheetTitle>
              </SheetHeader>
            <div className="px-4 pb-4 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={`flex items-center gap-1.5 text-xs ${severityBadgeClass[selected.severity]}`}
                >
                  <span className={`w-2 h-2 rounded-full ${severityStyle[selected.severity]}`} />
                  {selected.severity}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {typeLabel[selected.type] ?? selected.type}
                </Badge>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-0.5">{t("events.timestamp")}</p>
                <p className="text-sm text-foreground">{formatFullTimestamp(selected.timestamp)}</p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-0.5">{t("events.description")}</p>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {selected.description}
                </p>
              </div>

              {(selected.type === "deploy" || selected.type === "sync") && (
                <div className="pt-2">
                  <a
                    href={`/catalog/${encodeURIComponent(selected.title)}`}
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-border bg-card hover:bg-muted transition-colors px-4 py-2 text-foreground"
                  >
                    {t("events.viewInCatalog")}
                  </a>
                </div>
              )}

              {selected.type === "alert" && (
                <div className="pt-2 rounded-md bg-narwhal-warning/10 border border-narwhal-warning/30 px-3 py-2">
                  <p className="text-xs text-narwhal-warning">{t("events.checkAlertmanager")}</p>
                </div>
              )}
            </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
