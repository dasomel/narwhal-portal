"use client"

import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import { OverallBanner } from "./overall-banner"
import { ComponentGrid } from "./component-grid"
import { IncidentList } from "./incident-list"
import type { PlatformStatus } from "@/types/api"

export function StatusView({ isOperator }: { isOperator: boolean }) {
  const t = useT()

  const { data, isLoading, error } = useQuery<PlatformStatus>({
    queryKey: ["platform-status"],
    queryFn: () => fetch("/api/status").then((r) => {
      if (!r.ok) throw new Error(`status ${r.status}`)
      return r.json()
    }),
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <Card className="p-8 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("status.loading")}</span>
      </Card>
    )
  }

  if (error || !data) {
    return (
      <Card className="p-8 flex items-center justify-center">
        <span className="text-sm text-narwhal-danger">{t("status.error")}</span>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <OverallBanner status={data} />
      <ComponentGrid status={data} isOperator={isOperator} />
      <IncidentList incidents={data.incidents} />
    </div>
  )
}
