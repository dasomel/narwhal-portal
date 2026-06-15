"use client"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import type { SecuritySummary, Severity } from "@/types/security"

const SEVERITY_COLORS: Record<Severity, string> = {
  Critical: "#dc2626",
  High: "#f97316",
  Medium: "#f59e0b",
  Low: "#3b82f6",
  Unknown: "#6b7280",
}

const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]

interface Props {
  summary: SecuritySummary
}

export function SeverityDistributionChart({ summary }: Props) {
  const t = useT()

  const chartData = SEVERITIES.map((s) => ({
    name: s,
    count: summary.totals[s] ?? 0,
    color: SEVERITY_COLORS[s],
  }))

  const total = chartData.reduce((sum, d) => sum + d.count, 0)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-foreground">
            {t("security.chart.title")}
          </CardTitle>
          <span className="text-xs text-muted-foreground">Total: {total}</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {total === 0 ? (
          <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">
            {t("chart.noData")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const d = payload[0].payload as (typeof chartData)[0]
                    return (
                      <div className="bg-card/95 backdrop-blur-sm border border-border p-2.5 rounded-lg shadow-xl">
                        <p className="text-xs font-semibold" style={{ color: d.color }}>{d.name}</p>
                        <p className="text-sm font-bold text-foreground mt-0.5">{d.count}</p>
                      </div>
                    )
                  }
                  return null
                }}
              />
              <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                {chartData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
