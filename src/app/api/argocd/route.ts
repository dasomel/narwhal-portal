import { NextResponse } from "next/server"
import { getArgoApps } from "@/lib/argocd"
import { auth } from "@/lib/auth"
import type { ArgoCDResponse, ArgoCDApp } from "@/types/api"

export const dynamic = "force-dynamic"

export async function GET(): Promise<NextResponse<ArgoCDResponse | { error: string }>> {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const rawApps = await getArgoApps()

    const apps: ArgoCDApp[] = rawApps.map((a) => ({
      name: a.metadata.name,
      namespace: a.spec.destination?.namespace ?? a.metadata.namespace ?? "default",
      project: a.spec.project ?? "default",
      syncStatus: (a.status.sync.status as ArgoCDApp["syncStatus"]) ?? "Unknown",
      healthStatus: (a.status.health.status as ArgoCDApp["healthStatus"]) ?? "Progressing",
      revision: a.status.sync.revision?.slice(0, 7) ?? a.status.history?.at(-1)?.revision?.slice(0, 7) ?? null,
      lastSyncedAt: a.status.operationState?.finishedAt ?? a.status.history?.at(-1)?.deployedAt ?? null,
    }))

    const summary = {
      total: apps.length,
      synced: apps.filter((a) => a.syncStatus === "Synced").length,
      outOfSync: apps.filter((a) => a.syncStatus === "OutOfSync").length,
      degraded: apps.filter((a) => a.healthStatus === "Degraded" || a.healthStatus === "Missing").length,
    }

    return NextResponse.json({ summary, apps })
  } catch (err) {
    console.error("[api/argocd]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
