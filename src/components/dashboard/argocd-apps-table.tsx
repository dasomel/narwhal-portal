"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useT } from "@/lib/i18n-client"
import { useRole } from "@/hooks/use-role"
import type { ArgoCDResponse, ArgoCDApp } from "@/types/api"

// @deprecated — see docs/superpowers/specs/2026-04-17-dashboard-narwhal-redesign-design.md §5.3
// (old argocd-status.tsx is replaced by this component)

function sortApps(apps: ArgoCDApp[]): ArgoCDApp[] {
  const order = { Degraded: 0, OutOfSync: 1, Unknown: 2, Synced: 3 }
  return [...apps].sort((a, b) => {
    const ao = order[a.healthStatus as keyof typeof order] ?? 4
    const bo = order[b.healthStatus as keyof typeof order] ?? 4
    if (ao !== bo) return ao - bo
    const so = { OutOfSync: 0, Unknown: 1, Synced: 2 }
    return (so[a.syncStatus as keyof typeof so] ?? 3) - (so[b.syncStatus as keyof typeof so] ?? 3)
  })
}

function SyncBadge({ status }: { status: ArgoCDApp["syncStatus"] }) {
  const variants: Record<string, string> = {
    Synced: "bg-narwhal-success/15 text-narwhal-success",
    OutOfSync: "bg-narwhal-warning/15 text-narwhal-warning",
    Unknown: "bg-muted text-muted-foreground",
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${variants[status] ?? variants.Unknown}`}>
      {status}
    </span>
  )
}

function HealthBadge({ status }: { status: ArgoCDApp["healthStatus"] }) {
  const variants: Record<string, string> = {
    Healthy: "bg-narwhal-success/15 text-narwhal-success",
    Degraded: "bg-narwhal-danger/15 text-narwhal-danger",
    Progressing: "bg-narwhal-accent/15 text-narwhal-accent",
    Missing: "bg-muted text-muted-foreground",
    Suspended: "bg-muted text-muted-foreground",
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${variants[status] ?? variants.Missing}`}>
      {status}
    </span>
  )
}

function RelativeTime({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground text-xs">—</span>
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  const hrs = Math.floor(mins / 60)
  const days = Math.floor(hrs / 24)
  let label = "just now"
  if (days > 0) label = `${days}d ago`
  else if (hrs > 0) label = `${hrs}h ago`
  else if (mins > 0) label = `${mins}m ago`
  return <span className="text-muted-foreground text-xs font-mono">{label}</span>
}

interface ArgoCDAppsTableProps {
  /** When provided, skip the internal /api/argocd fetch and render these apps directly. */
  apps?: ArgoCDApp[]
}

export function ArgoCDAppsTable({ apps: propApps }: ArgoCDAppsTableProps = {}) {
  const t = useT()
  const { can } = useRole()
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery<ArgoCDResponse>({
    queryKey: ["argocd"],
    queryFn: () => fetch("/api/argocd").then((r) => r.json()),
    refetchInterval: 15_000,
    enabled: propApps === undefined,
  })

  const syncMutation = useMutation({
    mutationFn: (appName: string) =>
      fetch(`/api/argocd/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["argocd"] }),
  })

  if (propApps === undefined && isLoading) {
    return (
      <Card className="p-4 h-36 flex items-center justify-center" >
        <span className="text-sm text-text-secondary animate-pulse">{t("common.loading")}</span>
      </Card>
    )
  }

  if (propApps === undefined && (error || !data)) {
    return (
      <Card className="p-4" >
        <span className="text-sm text-narwhal-danger">{t("argocd.error")}</span>
      </Card>
    )
  }

  const appsSource = propApps ?? data!.apps
  const sorted = sortApps(appsSource)
  const totalCount = propApps !== undefined ? propApps.length : data!.summary.total

  return (
    <Card className="overflow-hidden" >
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-foreground">{t("argocd.title")}</h3>
        <span className="text-xs text-muted-foreground">{t("argocd.totalApps", { count: totalCount })}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow >
            <TableHead className="text-xs text-muted-foreground font-medium px-4">App</TableHead>
            <TableHead className="text-xs text-muted-foreground font-medium">Sync</TableHead>
            <TableHead className="text-xs text-muted-foreground font-medium">Health</TableHead>
            <TableHead className="text-xs text-muted-foreground font-medium">Last Synced</TableHead>
            {can("sync") && <TableHead className="text-xs text-muted-foreground font-medium">Action</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((app) => (
            <TableRow key={app.name} >
              <TableCell className="text-[12px] text-foreground font-medium px-4 py-2">{app.name}</TableCell>
              <TableCell className="py-2">
                <SyncBadge status={app.syncStatus} />
              </TableCell>
              <TableCell className="py-2">
                <HealthBadge status={app.healthStatus} />
              </TableCell>
              <TableCell className="py-2">
                <RelativeTime iso={app.lastSyncedAt} />
              </TableCell>
              {can("sync") && (
                <TableCell className="py-2">
                  {(app.syncStatus === "OutOfSync" || app.healthStatus === "Degraded") && (
                    <button
                      onClick={() => syncMutation.mutate(app.name)}
                      disabled={syncMutation.isPending}
                      className="text-xs px-2 py-1 rounded bg-muted text-narwhal-accent hover:bg-muted/70 transition-colors disabled:opacity-50"
                    >
                      {t("catalog.sync")}
                    </button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}
