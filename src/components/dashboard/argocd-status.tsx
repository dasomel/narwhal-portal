// @deprecated — see docs/superpowers/specs/2026-04-17-dashboard-narwhal-redesign-design.md §5.3
// Replaced by ArgoCDAppsTable. Delete after Phase A validation.
"use client"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import type { ArgoCDResponse } from "@/types/api"
import { DataState } from "@/components/ui/data-state"

export function ArgoCDStatus() {
  const t = useT()
  const { data, isLoading, isError, refetch } = useQuery<ArgoCDResponse>({
    queryKey: ["argocd"],
    queryFn: () => fetch("/api/argocd").then((r) => r.json()),
    refetchInterval: 10_000,
  })

  if (isLoading && !data) return <Card className="p-5"><DataState state="loading" onRetry={() => { void refetch() }} /></Card>
  if (!data) return <Card className="p-5"><DataState state={isError ? "unavailable" : "loading"} onRetry={() => { void refetch() }} /></Card>

  return (
    <Card className="p-5">
      {isError && <div className="mb-3"><DataState state="stale" onRetry={() => { void refetch() }} /></div>}
      <h3 className="font-semibold text-foreground mb-3">{t("argocd.title")}</h3>
      <div className="flex gap-3 flex-wrap">
        <Badge variant="default" className="bg-green-100 text-green-700">
          ✓ Synced: {data.summary.synced}
        </Badge>
        <Badge variant="default" className="bg-yellow-100 text-yellow-700">
          ⚠ OutOfSync: {data.summary.outOfSync}
        </Badge>
        <Badge variant="default" className="bg-red-100 text-red-700">
          ✗ Degraded: {data.summary.degraded}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mt-3">{t("argocd.totalApps", { count: data.summary.total })}</p>
    </Card>
  )
}
