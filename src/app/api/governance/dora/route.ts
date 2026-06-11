import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps } from "@/lib/argocd"
import { getCommitTimestamp } from "@/lib/gitea"
import { cacheGet, cacheSet } from "@/lib/valkey"
import { assertPromQLSafe } from "@/lib/validation"

export const dynamic = "force-dynamic"

const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090"

export interface DoraDeployment {
  app: string
  namespace: string
  revision: string
  deployedAt: string
  status: "Succeeded" | "Failed"
}

export interface DoraPerApp {
  app: string
  namespace: string
  deploys: number
  lastDeployedAt: string | null
  leadTimeHours: number | null
}

export interface DoraMetrics {
  period: "7d"
  deployFrequency: number
  totalDeploys: number
  leadTimeHours: number | null
  changeFailureRate: number
  mttrMinutes: number | null
  dailyDeploys: { date: string; count: number }[]
  perApp: DoraPerApp[]
  recent: DoraDeployment[]
}

async function getMttrMinutes(sevenDaysAgoMs: number): Promise<number | null> {
  try {
    const end = Math.floor(Date.now() / 1000)
    const start = Math.floor(sevenDaysAgoMs / 1000)
    const promql = 'max by (alertname, namespace) (ALERTS{alertstate="firing",severity!="none"})'
    assertPromQLSafe(promql)

    const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${start}&end=${end}&step=300`
    const res = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.warn(`[dora-metrics] Prometheus query failed: ${res.status}`)
      return null
    }

    const data = await res.json()
    const results = data?.data?.result ?? []
    if (results.length === 0) return null

    const episodes: number[] = []
    const tolerance = 600 // 10 minutes tolerance to group consecutive points

    for (const r of results) {
      const values: [number, string][] = r.values ?? []
      if (values.length === 0) continue

      const timestamps = values.map(([ts]) => Number(ts)).sort((a, b) => a - b)

      let currentEpisodeStart = timestamps[0]
      let currentEpisodeLast = timestamps[0]

      for (let i = 1; i < timestamps.length; i++) {
        const ts = timestamps[i]
        if (ts - currentEpisodeLast <= tolerance) {
          currentEpisodeLast = ts
        } else {
          // Episode ended. Did it end within the window?
          if (currentEpisodeLast < end - 600) {
            const durationMinutes = Math.max(1, Math.round((currentEpisodeLast - currentEpisodeStart + 300) / 60))
            episodes.push(durationMinutes)
          }
          currentEpisodeStart = ts
          currentEpisodeLast = ts
        }
      }

      // Final episode
      if (currentEpisodeLast < end - 600) {
        const durationMinutes = Math.max(1, Math.round((currentEpisodeLast - currentEpisodeStart + 300) / 60))
        episodes.push(durationMinutes)
      }
    }

    if (episodes.length === 0) return null
    const totalMinutes = episodes.reduce((sum, d) => sum + d, 0)
    return Math.round(totalMinutes / episodes.length)
  } catch (err) {
    console.warn("[dora-metrics] MTTR query failed:", err)
    return null
  }
}

export async function GET() {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const cacheKey = "governance:dora:v2"
  try {
    const cached = await cacheGet<DoraMetrics>(cacheKey)
    if (cached) return NextResponse.json(cached)
  } catch (err) {
    console.warn("[governance/dora] Cache lookup failed:", err)
  }

  try {
    const apps = await getArgoApps()

    const now = Date.now()
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000

    interface FlatDeploy {
      app: string
      namespace: string
      revision: string
      deployedAt: string
      deployedAtMs: number
      isLatest: boolean
      phase?: string
    }

    const deployments: FlatDeploy[] = []

    for (const app of apps) {
      const history = app.status.history ?? []
      const namespace = app.spec.destination?.namespace || "default"
      const appName = app.metadata.name
      const phase = app.status.operationState?.phase

      for (let i = 0; i < history.length; i++) {
        const h = history[i]
        const deployedAtMs = new Date(h.deployedAt).getTime()
        if (deployedAtMs > sevenDaysAgo) {
          deployments.push({
            app: appName,
            namespace,
            revision: h.revision,
            deployedAt: h.deployedAt,
            deployedAtMs,
            isLatest: i === history.length - 1,
            phase,
          })
        }
      }
    }

    // Sort deployments: newest first
    deployments.sort((a, b) => b.deployedAtMs - a.deployedAtMs)

    // Parallel fetch unique commit SHAs from Gitea
    const uniqueShas = Array.from(new Set(deployments.map(d => d.revision)))
    const commitTimeMap: Record<string, string | null> = {}
    await Promise.all(
      uniqueShas.map(async sha => {
        commitTimeMap[sha] = await getCommitTimestamp(sha)
      })
    )

    const recent: DoraDeployment[] = []
    const appStatsMap: Record<string, {
      app: string
      namespace: string
      deploys: number
      lastDeployedAtMs: number | null
      lastDeployedAt: string | null
      leadTimeSumMs: number
      leadTimeCount: number
    }> = {}

    let totalLeadTimeSumMs = 0
    let totalLeadTimeCount = 0
    let failedDeploysCount = 0

    for (const d of deployments) {
      const status: "Succeeded" | "Failed" = (d.isLatest && d.phase === "Failed") ? "Failed" : "Succeeded"
      if (status === "Failed") {
        failedDeploysCount++
      }

      if (recent.length < 20) {
        recent.push({
          app: d.app,
          namespace: d.namespace,
          revision: d.revision.slice(0, 7),
          deployedAt: d.deployedAt,
          status,
        })
      }

      if (!appStatsMap[d.app]) {
        appStatsMap[d.app] = {
          app: d.app,
          namespace: d.namespace,
          deploys: 0,
          lastDeployedAtMs: null,
          lastDeployedAt: null,
          leadTimeSumMs: 0,
          leadTimeCount: 0,
        }
      }
      const stats = appStatsMap[d.app]
      stats.deploys++
      if (stats.lastDeployedAtMs === null || d.deployedAtMs > stats.lastDeployedAtMs) {
        stats.lastDeployedAtMs = d.deployedAtMs
        stats.lastDeployedAt = d.deployedAt
      }

      const commitDateStr = commitTimeMap[d.revision]
      if (commitDateStr) {
        const commitTimeMs = new Date(commitDateStr).getTime()
        const leadTimeMs = d.deployedAtMs - commitTimeMs
        if (leadTimeMs >= 0) {
          stats.leadTimeSumMs += leadTimeMs
          stats.leadTimeCount++
          totalLeadTimeSumMs += leadTimeMs
          totalLeadTimeCount++
        }
      }
    }

    const perApp: DoraPerApp[] = Object.values(appStatsMap).map(stats => {
      const leadTimeHours = stats.leadTimeCount > 0 
        ? Math.round((stats.leadTimeSumMs / stats.leadTimeCount / 3600000) * 10) / 10
        : null

      return {
        app: stats.app,
        namespace: stats.namespace,
        deploys: stats.deploys,
        lastDeployedAt: stats.lastDeployedAt,
        leadTimeHours,
      }
    })

    perApp.sort((a, b) => b.deploys - a.deploys)
    const perAppSlice = perApp.slice(0, 15)

    const dailyDeploys: { date: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000)
      const month = String(d.getMonth() + 1).padStart(2, "0")
      const date = String(d.getDate()).padStart(2, "0")
      dailyDeploys.push({ date: `${month}-${date}`, count: 0 })
    }

    for (const d of deployments) {
      const deployDate = new Date(d.deployedAtMs)
      const month = String(deployDate.getMonth() + 1).padStart(2, "0")
      const date = String(deployDate.getDate()).padStart(2, "0")
      const dateStr = `${month}-${date}`

      const day = dailyDeploys.find(day => day.date === dateStr)
      if (day) {
        day.count++
      }
    }

    const deployFrequency = Math.round((deployments.length / 7) * 10) / 10
    const leadTimeHours = totalLeadTimeCount > 0
      ? Math.round((totalLeadTimeSumMs / totalLeadTimeCount / 3600000) * 10) / 10
      : null
    const changeFailureRate = deployments.length > 0
      ? Math.round((failedDeploysCount / deployments.length) * 100)
      : 0

    const mttrMinutes = await getMttrMinutes(sevenDaysAgo)

    const result: DoraMetrics = {
      period: "7d",
      deployFrequency,
      totalDeploys: deployments.length,
      leadTimeHours,
      changeFailureRate,
      mttrMinutes,
      dailyDeploys,
      perApp: perAppSlice,
      recent,
    }

    // ArgoCD가 일시적으로 빈 목록을 반환한 경우(0건)는 캐시에 박제하지 않는다
    if (deployments.length > 0) {
      try {
        await cacheSet(cacheKey, result, 120) // Cached for 120s
      } catch (err) {
        console.warn("[governance/dora] Cache save failed:", err)
      }
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("[governance/dora]", err)
    return NextResponse.json({
      period: "7d",
      deployFrequency: 0,
      totalDeploys: 0,
      leadTimeHours: null,
      changeFailureRate: 0,
      mttrMinutes: null,
      dailyDeploys: [],
      perApp: [],
      recent: [],
    })
  }
}
