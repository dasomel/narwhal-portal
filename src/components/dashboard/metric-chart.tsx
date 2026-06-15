"use client"

import { useQuery } from "@tanstack/react-query"
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"

interface RangeResponse {
  metric: string
  data: Array<{ timestamp: number; value: number }>
}

const METRIC_CONFIG: Record<string, { color: string; unit: string }> = {
  cpu: { color: "#6366f1", unit: "%" },
  memory: { color: "#10b981", unit: "%" },
  pods: { color: "#f59e0b", unit: "" },
  network: { color: "#3b82f6", unit: "MB/s" },
  disk: { color: "#f97316", unit: "%" },
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

export function MetricChart({ metric, minutes = 60, node }: { metric: string; minutes?: number; node?: string }) {
  const t = useT()
  const { data, isLoading } = useQuery<RangeResponse>({
    queryKey: ["metrics-range", metric, minutes, node],
    queryFn: () => {
      const url = new URL(`/api/metrics/range`, window.location.origin)
      url.searchParams.set("metric", metric)
      url.searchParams.set("minutes", String(minutes))
      if (node) url.searchParams.set("node", node)
      return fetch(url).then((r) => r.json())
    },
    refetchInterval: 30_000,
  })

  const config = METRIC_CONFIG[metric] ?? { color: "#6366f1", unit: "" }
  const titleMap: Record<string, string> = {
    cpu: "chart.cpu",
    memory: "chart.memory",
    pods: "chart.pods",
    network: "chart.network",
    disk: "chart.disk",
  }
  const titleKey = titleMap[metric] ?? "chart.cpu"

  const chartData = (data?.data ?? []).map((d) => ({
    time: formatTime(d.timestamp),
    value: Math.round(d.value * 10) / 10,
  }))

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-foreground">{t(titleKey as any)}</CardTitle>
          <span className="text-xs text-muted-foreground font-medium">Last {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
            {t("chart.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart syncId="dashboard-metrics" data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={config.color} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={config.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                domain={config.unit === "%" ? [0, 100] : ["auto", "auto"]}
                tickFormatter={(v) => config.unit === "%" ? `${v}%` : config.unit ? `${v}` : `${v}`}
                unit={config.unit !== "%" ? config.unit : undefined}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    return (
                      <div className="bg-card/95 backdrop-blur-sm border border-border p-2.5 rounded-lg shadow-xl flex flex-col gap-1 min-w-[100px]">
                        <p className="text-xs font-black text-muted-foreground uppercase tracking-widest leading-none">{payload[0].payload.time}</p>
                        <div className="flex items-baseline gap-1.5 mt-1">
                          <span className="text-sm font-black text-foreground leading-none">{payload[0].value}</span>
                          <span className="text-xs font-bold text-muted-foreground mb-0.5">{config.unit}</span>
                        </div>
                        <p className="text-[9px] font-bold text-narwhal-accent uppercase tracking-tighter mt-1 opacity-80">{metric}</p>
                      </div>
                    )
                  }
                  return null
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={config.color}
                strokeWidth={2}
                fill={`url(#grad-${metric})`}
                animationDuration={1500}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
