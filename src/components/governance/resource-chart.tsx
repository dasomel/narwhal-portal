"use client"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import { ResourceDetailDrawer } from "./resource-detail-drawer"

interface NamespaceUsage {
  namespace: string
  cpuPercent: number
  memoryPercent: number
  podCount: number
}

export function ResourceChart() {
  const t = useT()
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null)

  const { data = [], isLoading } = useQuery<NamespaceUsage[]>({
    queryKey: ["governance-resources"],
    queryFn: () => fetch("/api/governance/resources").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const handleChartClick = (state: any) => {
    if (state && state.activeLabel && state.activePayload && state.activePayload.length > 0) {
      setSelectedNamespace(state.activeLabel)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-foreground">{t("resources.title")}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : data.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">
            {t("resources.empty")}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={data}
              margin={{ top: 4, right: 16, left: -10, bottom: 60 }}
              onClick={handleChartClick}
              style={{ cursor: "pointer" }}
            >
              <XAxis
                dataKey="namespace"
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                angle={-35}
                textAnchor="end"
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                formatter={(value) => [`${value}%`]}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Bar dataKey="cpuPercent" name={t("resources.cpu")} fill="#6366f1" radius={[3, 3, 0, 0]} cursor="pointer" />
              <Bar dataKey="memoryPercent" name={t("resources.memory")} fill="#10b981" radius={[3, 3, 0, 0]} cursor="pointer" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>

      <ResourceDetailDrawer
        namespace={selectedNamespace ?? ""}
        open={!!selectedNamespace}
        onOpenChange={(open) => !open && setSelectedNamespace(null)}
      />
    </Card>
  )
}
