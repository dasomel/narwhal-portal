"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useT, useLocale } from "@/lib/i18n-client"
import type { Locale } from "@/lib/i18n"
import { useRole } from "@/hooks/use-role"
import type { TimelineEvent } from "@/app/api/events/route"

interface Alert {
  fingerprint: string
  status: { state: string }
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: string
}

interface FeedItem {
  id: string
  timestamp: string
  severity: "info" | "warning" | "critical"
  title: string
  detail: string
  source: string
  href?: string
  _raw?: Alert | TimelineEvent
  _kind: "alert" | "event"
}

function normalizeSeverity(sev: string): FeedItem["severity"] {
  if (sev === "critical") return "critical"
  if (sev === "warning") return "warning"
  return "info"
}

function severityColor(sev: FeedItem["severity"]): string {
  if (sev === "critical") return "text-narwhal-danger border-narwhal-danger"
  if (sev === "warning") return "text-narwhal-warning border-narwhal-warning"
  return "text-narwhal-accent border-narwhal-accent"
}

function severityDot(sev: FeedItem["severity"]): string {
  if (sev === "critical") return "bg-narwhal-danger"
  if (sev === "warning") return "bg-narwhal-warning"
  return "bg-narwhal-accent"
}

function relativeTime(iso: string, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t("events.relative.justNow")
  if (mins < 60) return t("events.relative.minutesAgo", { n: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t("events.relative.hoursAgo", { n: hrs })
  return t("events.relative.daysAgo", { n: Math.floor(hrs / 24) })
}

function formatOccurrenceTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function AlertDetail({
  alert,
  onClose,
  onSilence,
  canSilence,
}: {
  alert: Alert
  onClose: () => void
  onSilence: (alertname: string) => void
  canSilence: boolean
}) {
  const t = useT()
  const alertname = alert.labels.alertname ?? "Alert"
  const runbook = alert.annotations.runbook_url ?? alert.annotations.runbook

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-[400px] sm:w-[480px]"
      >
        <SheetHeader>
          <SheetTitle className="text-foreground">{t("alerts.detail.title")}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4 text-[13px]">
          <div>
            <div className="text-muted-foreground text-xs mb-1">{t("alerts.detail.startsAt")}</div>
            <div className="font-mono text-[12px] text-muted-foreground">{alert.startsAt}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">{t("alerts.detail.labels")}</div>
            <div className="space-y-1">
              {Object.entries(alert.labels).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-muted-foreground">{k}:</span>
                  <span className="text-foreground">{v}</span>
                </div>
              ))}
            </div>
          </div>
          {Object.keys(alert.annotations).length > 0 && (
            <div>
              <div className="text-muted-foreground text-xs mb-1">{t("alerts.detail.annotations")}</div>
              <div className="space-y-1">
                {Object.entries(alert.annotations)
                  .filter(([k]) => k !== "runbook_url" && k !== "runbook")
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-muted-foreground">{k}:</span>
                      <span className="text-foreground">{v}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
          {runbook && (
            <div>
              <div className="text-muted-foreground text-xs mb-1">{t("alerts.detail.runbook")}</div>
              <a
                href={runbook}
                target="_blank"
                rel="noopener noreferrer"
                className="text-narwhal-accent hover:text-narwhal-accent/80 text-[12px] underline"
              >
                {runbook}
              </a>
            </div>
          )}
          {canSilence && (
            <button
              onClick={() => {
                onSilence(alert.labels.alertname ?? "")
                onClose()
              }}
              className="mt-2 px-4 py-2 rounded bg-muted text-narwhal-accent hover:bg-muted/70 text-[12px] transition-colors"
            >
              {t("alerts.silence")}
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function ActivityFeed() {
  const t = useT()
  const locale = useLocale()
  const { can } = useRole()
  const canSilence = can("silence")
  const queryClient = useQueryClient()

  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)

  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ["alerts"],
    queryFn: () =>
      fetch("/api/alerts")
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : [])),
    refetchInterval: 15_000,
  })

  const { data: events = [] } = useQuery<TimelineEvent[]>({
    queryKey: ["events"],
    queryFn: () =>
      fetch("/api/events")
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : [])),
    refetchInterval: 30_000,
  })

  const silenceMutation = useMutation({
    mutationFn: (alertname: string) =>
      fetch("/api/alerts/silence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertname, duration: 60 }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  })

  const alertItems: FeedItem[] = alerts.map((a) => ({
    id: `alert-${a.fingerprint}`,
    timestamp: a.startsAt,
    severity: normalizeSeverity(a.labels.severity ?? "warning"),
    title: a.labels.alertname ?? "Alert",
    detail: a.annotations.description ?? a.annotations.summary ?? "",
    source: "alertmanager",
    _raw: a,
    _kind: "alert",
  }))

  const eventItems: FeedItem[] = events.map((e) => ({
    id: `event-${e.id}`,
    timestamp: e.timestamp,
    severity: normalizeSeverity(e.severity === "error" ? "critical" : e.severity),
    title: e.title,
    detail: e.description,
    source: `k8s/${e.type}`,
    _raw: e,
    _kind: "event",
  }))

  const feed: FeedItem[] = [...alertItems, ...eventItems].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  return (
    <>
      <Card className="overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-[13px] font-semibold text-foreground">⚡ Activity Feed</h3>
        </div>
        {feed.length === 0 ? (
          <div className="px-4 pb-4 text-[13px] text-muted-foreground">{t("events.empty")}</div>
        ) : (
          <div className="divide-y divide-border">
            {feed.slice(0, 20).map((item) => (
              <button
                key={item.id}
                className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-muted/50 transition-colors"
                onClick={() => {
                  if (item._kind === "alert") setSelectedAlert(item._raw as Alert)
                }}
              >
                <span
                  className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${severityDot(item.severity)}`}
                />
                <div className="flex-1 min-w-0">
                  <span className={`text-[12px] font-medium ${severityColor(item.severity).split(" ")[0]}`}>
                    {item.title}
                  </span>
                  <div className="text-xs text-muted-foreground mt-0.5 truncate">{item.detail}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                    <span>{item.source}</span>
                    <span className="text-border">·</span>
                    <span className="tabular-nums">{formatOccurrenceTime(item.timestamp, locale)}</span>
                    <span className="text-border">·</span>
                    <span>{relativeTime(item.timestamp, t)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {selectedAlert && (
        <AlertDetail
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onSilence={(alertname) => silenceMutation.mutate(alertname)}
          canSilence={canSilence}
        />
      )}
    </>
  )
}
