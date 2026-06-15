"use client"

/**
 * ServiceCostTab — spec §5.6 /catalog/[name]?tab=cost
 * 서비스 비용 + Top 5 Pod 표 + 7일 추이
 * TODO(wrap-up): i18n
 */

import { useQuery } from "@tanstack/react-query"
import { useT } from "@/lib/i18n-client"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface TopPod {
  pod: string
  cpu: number
  memGb: number
  hourly: number
}

interface CostDetailResponse {
  serviceId: string
  generatedAt: string
  unitPrices: { cpuHourly: number; memGbHourly: number; storageGbHourly: number }
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number
  topPods: TopPod[]
  notice?: string
}

interface TrendPoint {
  date: string
  total: number
}

interface TrendResponse {
  scope: string
  id: string
  days: number
  points: TrendPoint[]
  notice?: string
}

interface Props {
  serviceId: string
}

export function ServiceCostTab({ serviceId }: Props) {
  const t = useT()
  const { data: detail, isLoading: detailLoading } = useQuery<CostDetailResponse>({
    queryKey: ["cost-service", serviceId],
    queryFn: () => fetch(`/api/cost/${serviceId}`).then((r) => r.json()),
    refetchInterval: 60_000,
  })

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["cost-trend", "service", serviceId, 7],
    queryFn: () =>
      fetch(`/api/cost/trend?scope=service&id=${serviceId}&days=7`).then((r) =>
        r.json()
      ),
    refetchInterval: 300_000,
  })

  const chartData = (trendData?.points ?? []).map((p) => ({
    date: p.date.slice(5), // MM-DD
    total: p.total,
  }))

  return (
    <div className="space-y-4">
      {/* 에러/notice 배너 */}
      {detail?.notice && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
          {detail.notice}
        </div>
      )}

      {/* 비용 요약 카드 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.hourlyCost")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {detailLoading ? (
              <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            ) : (
              <p className="text-2xl font-bold text-foreground">
                ${(detail?.totalHourly ?? 0).toFixed(4)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.estimatedMonthlyCost")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {detailLoading ? (
              <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            ) : (
              <p className="text-2xl font-bold text-foreground">
                ${(detail?.totalMonthly ?? 0).toFixed(2)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-2 sm:col-span-1">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.cpuMemory")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1">
            {detailLoading ? (
              <div className="h-8 w-32 animate-pulse rounded bg-muted" />
            ) : (
              <>
                <p className="text-sm text-indigo-600 dark:text-indigo-400">
                  CPU {detail?.cpu.cores.toFixed(3) ?? "0"} cores —{" "}
                  <span className="font-semibold">${(detail?.cpu.hourly ?? 0).toFixed(4)}/h</span>
                </p>
                <p className="text-sm text-emerald-600 dark:text-emerald-400">
                  Mem {detail?.memory.gb.toFixed(2) ?? "0"} GB —{" "}
                  <span className="font-semibold">${(detail?.memory.hourly ?? 0).toFixed(4)}/h</span>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 7일 추이 차트 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-foreground">
            {t("cost.trendTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {trendLoading ? (
            <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
              {trendData?.notice ?? t("cost.noTrendData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 16, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--card)",
                  }}
                  formatter={(value) => [`$${Number(value).toFixed(4)}/h`, t("cost.cost")]}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  animationDuration={800}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top 5 Pod 표 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-foreground">
            {t("cost.top5Pods")}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {detailLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-9 w-full animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : !detail?.topPods || detail.topPods.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("cost.noPodData")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pod</TableHead>
                  <TableHead className="text-right">CPU cores</TableHead>
                  <TableHead className="text-right">Mem GB</TableHead>
                  <TableHead className="text-right">$/h</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.topPods.map((pod) => (
                  <TableRow key={pod.pod}>
                    <TableCell className="font-mono text-xs">{pod.pod}</TableCell>
                    <TableCell className="text-right text-xs text-indigo-600 dark:text-indigo-400">
                      {pod.cpu.toFixed(3)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-emerald-600 dark:text-emerald-400">
                      {pod.memGb.toFixed(3)}
                    </TableCell>
                    <TableCell className="text-right text-xs font-semibold">
                      ${pod.hourly.toFixed(4)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
