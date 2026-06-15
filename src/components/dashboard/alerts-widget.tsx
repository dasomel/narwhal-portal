// @deprecated — see docs/superpowers/specs/2026-04-17-dashboard-narwhal-redesign-design.md §5.3
// Merged into ActivityFeed (silence action moved to detail sheet). Delete after Phase A validation.
"use client"
import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useT } from "@/lib/i18n-client"

interface Alert {
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt?: string
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-2 border-b last:border-0">
      <span className="text-xs text-muted-foreground pt-0.5 break-all">{label}</span>
      <span className="text-sm text-foreground break-all">{value ?? "—"}</span>
    </div>
  )
}

function SilenceButton({ alertname }: { alertname: string }) {
  const t = useT()
  const [silenced, setSilenced] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const silenceMutation = useMutation({
    mutationFn: () =>
      fetch("/api/alerts/silence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertname, duration: 60 }),
      }).then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      }),
    onSuccess: () => setSilenced(true),
  })

  if (silenced) {
    return (
      <Badge className="bg-muted text-muted-foreground text-xs">{t("alerts.silenced")}</Badge>
    )
  }

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        disabled={silenceMutation.isPending}
        className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {t("alerts.silence")}
      </button>

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("alerts.silence")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("alerts.confirmSilence", { alertname })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDialogOpen(false)
                silenceMutation.mutate()
              }}
            >
              {t("alerts.silence")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function AlertsWidget() {
  const t = useT()
  const { data: session } = useSession()
  const role = (session?.user as { role?: string })?.role ?? "guest"
  const canSilence = role === "cluster-admin" || role === "developer"

  const [selected, setSelected] = useState<Alert | null>(null)

  const { data: alerts = [], isLoading } = useQuery<Alert[]>({
    queryKey: ["alerts"],
    queryFn: () => fetch("/api/alerts").then((r) => r.json()).then((d) => Array.isArray(d) ? d : []),
    refetchInterval: 15_000,
  })

  if (isLoading) return <Card className="p-5 h-36 flex items-center justify-center"><span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span></Card>

  const selectedAlertname = selected?.labels.alertname ?? ""
  const selectedSeverity = selected?.labels.severity ?? ""
  const isCritical = selectedSeverity === "critical"

  const extraLabels = selected
    ? Object.entries(selected.labels).filter(([k]) => k !== "alertname" && k !== "severity")
    : []

  return (
    <>
      <Card className="p-5">
        <h3 className="font-semibold text-foreground mb-3">
          {t("alerts.title")}{" "}
          {alerts.length > 0 && (
            <Badge className="bg-narwhal-danger/15 text-narwhal-danger">{alerts.length}</Badge>
          )}
        </h3>
        {alerts.length === 0 ? (
          <p className="text-sm text-narwhal-success">{t("alerts.none")}</p>
        ) : (
          <ul className="space-y-1.5">
            {alerts.slice(0, 5).map((a, i) => (
              <li
                key={i}
                onClick={() => setSelected(a)}
                className="text-sm flex gap-2 items-center cursor-pointer hover:bg-muted rounded px-1 -mx-1 transition-colors"
              >
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  a.labels.severity === "critical"
                    ? "bg-narwhal-danger/15 text-narwhal-danger"
                    : "bg-narwhal-warning/15 text-narwhal-warning"
                }`}>
                  {a.labels.severity ?? "warn"}
                </span>
                <span className="text-foreground truncate flex-1">{a.labels.alertname}</span>
                {canSilence && <SilenceButton alertname={a.labels.alertname ?? `alert-${i}`} />}
              </li>
            ))}
            {alerts.length > 5 && <li className="text-xs text-muted-foreground">{t("alerts.more", { count: alerts.length - 5 })}</li>}
          </ul>
        )}
      </Card>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full max-w-md overflow-y-auto overflow-x-hidden">
          {selected && (
            <>
              <SheetHeader className="mb-2">
                <SheetTitle className="text-base">{selectedAlertname || t("alerts.detail.title")}</SheetTitle>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className={isCritical ? "bg-narwhal-danger/15 text-narwhal-danger" : "bg-narwhal-warning/15 text-narwhal-warning"}>
                    {selectedSeverity || "warn"}
                  </Badge>
                </div>
              </SheetHeader>

              <div className="px-4 pb-4">
                <DetailRow
                  label={t("alerts.detail.startsAt")}
                  value={
                    selected.startsAt
                      ? new Date(selected.startsAt).toLocaleString("ko-KR")
                      : "—"
                  }
                />

                {extraLabels.length > 0 && (
                  <div className="mt-3 mb-1">
                    <p className="text-xs font-medium text-muted-foreground mb-1">{t("alerts.detail.labels")}</p>
                    {extraLabels.map(([k, v]) => (
                      <DetailRow key={k} label={k} value={v} />
                    ))}
                  </div>
                )}

                {(selected.annotations.summary || selected.annotations.description || selected.annotations.runbook_url) && (
                  <div className="mt-3 mb-1">
                    <p className="text-xs font-medium text-muted-foreground mb-1">{t("alerts.detail.annotations")}</p>
                    {selected.annotations.summary && (
                      <DetailRow label="summary" value={selected.annotations.summary} />
                    )}
                    {selected.annotations.description && (
                      <DetailRow
                        label="description"
                        value={
                          <span className="text-xs leading-relaxed whitespace-pre-wrap">
                            {selected.annotations.description}
                          </span>
                        }
                      />
                    )}
                    {selected.annotations.runbook_url && (
                      <DetailRow
                        label={t("alerts.detail.runbook")}
                        value={
                          <a
                            href={selected.annotations.runbook_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-narwhal-accent hover:underline text-xs break-all"
                          >
                            {selected.annotations.runbook_url}
                          </a>
                        }
                      />
                    )}
                  </div>
                )}

                {canSilence && (
                  <div className="mt-4">
                    <SilenceButton alertname={selectedAlertname} />
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
