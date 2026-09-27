"use client"

import { AlertTriangle, CheckCircle2, CircleHelp, Info, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react"
import type { DependencyState } from "@/lib/dependency-health"
import { useT } from "@/lib/i18n-client"
import { Button } from "@/components/ui/button"

export type DataStateValue = DependencyState | "loading" | "error"

interface DataStateProps {
  state: DataStateValue
  onRetry?: () => void
  observedAt?: string
  now?: number
  freshnessSeconds?: number
  reason?: string
  detailKey?: "costUnavailable" | "costPartial"
  className?: string
  variant?: "banner" | "inline"
}

export function DataState({ state, onRetry, observedAt, now, freshnessSeconds, reason, detailKey, className, variant = "banner" }: DataStateProps) {
  const t = useT()
  const content = (() => {
    switch (state) {
      case "loading": return { label: t("dataState.loading"), Icon: LoaderCircle, role: "status" as const }
      case "ok": return { label: t("dataState.ok"), Icon: CheckCircle2, role: "status" as const }
      case "partial": return { label: t("dataState.partial"), Icon: Info, role: "status" as const }
      case "stale": return { label: t("dataState.stale"), Icon: AlertTriangle, role: "status" as const }
      case "empty": return { label: t("dataState.empty"), Icon: CircleHelp, role: "status" as const }
      case "unauthorized": return { label: t("dataState.unauthorized"), Icon: LockKeyhole, role: "alert" as const }
      case "unavailable": return { label: t("dataState.unavailable"), Icon: AlertTriangle, role: "alert" as const }
      case "error": return { label: t("dataState.error"), Icon: AlertTriangle, role: "alert" as const }
    }
  })()
  const { Icon } = content
  const age = freshnessSeconds ?? (observedAt && now !== undefined ? Math.max(0, Math.floor((now - Date.parse(observedAt)) / 1000)) : undefined)
  const minutes = age === undefined ? undefined : Math.floor(age / 60)

  const inline = variant === "inline"
  return (
    <div className={`flex ${inline ? "items-center gap-1.5 whitespace-nowrap text-xs" : "flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"} ${inline ? (state === "unavailable" || state === "error" || state === "unauthorized" ? "text-destructive" : "text-foreground") : (state === "unavailable" || state === "error" || state === "unauthorized" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-muted/30 text-foreground")} ${className ?? ""}`}>
      <div role={content.role} className="flex items-center gap-2">
        <Icon aria-hidden="true" className={`${inline ? "size-3" : "size-4"} shrink-0 ${state === "loading" ? "animate-spin" : ""}`} />
        <span>{content.label}</span>
        {reason && <span>{reason}</span>}
        {detailKey === "costUnavailable" && <span>{t("cost.telemetryUnavailable")}</span>}
        {detailKey === "costPartial" && <span>{t("cost.telemetryPartial")}</span>}
      </div>
      {minutes !== undefined && <span className="text-xs text-muted-foreground">{t("dataState.updatedMinutes", { count: String(minutes) })}</span>}
      {onRetry && <Button type="button" size="sm" variant={inline ? "ghost" : "outline"} className={inline ? "h-auto border-0 bg-transparent px-1 py-0 text-xs shadow-none hover:bg-transparent" : undefined} onClick={onRetry}><RefreshCw aria-hidden="true" />{t("common.retry")}</Button>}
    </div>
  )
}
