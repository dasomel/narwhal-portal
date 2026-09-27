"use client"

import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, CircleX } from "lucide-react"
import { useT } from "@/lib/i18n-client"

type SummaryState = "ok" | "degraded" | "unavailable"
interface HealthSummary {
  state: SummaryState
  observedAt: string
}

export function DependencyHealthIndicator() {
  const t = useT()
  const { data } = useQuery<HealthSummary>({
    queryKey: ["health-summary"],
    queryFn: async () => {
      const response = await fetch("/api/health/summary")
      if (!response.ok) throw new Error("Health summary unavailable")
      return response.json() as Promise<HealthSummary>
    },
    refetchInterval: 60_000,
  })

  if (!data) return null

  let Icon = CheckCircle2
  let label = t("healthSummary.ok")
  let style = "text-emerald-700 dark:text-emerald-400"
  switch (data.state) {
    case "degraded":
      Icon = AlertTriangle
      label = t("healthSummary.degraded")
      style = "text-amber-700 dark:text-amber-400"
      break
    case "unavailable":
      Icon = CircleX
      label = t("healthSummary.unavailable")
      style = "text-destructive"
      break
    case "ok":
      break
  }

  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 text-xs font-medium ${style}`}>
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  )
}
