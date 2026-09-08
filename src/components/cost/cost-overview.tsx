"use client"

/**
 * CostOverview — spec §5.5 상단 카드(시간당/월 + CPU/Mem/Storage 분해) + 30일 추이 라인차트
 * 차트: Recharts (resource-chart.tsx 동일 라이브러리)
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

interface CostItem {
  id: string
  cpu: { cores: number; hourly: number }
  memory: { gb: number; hourly: number }
  storage: { gb: number; hourly: number }
  totalHourly: number
  totalMonthly: number
}

interface CostResponse {
  scope: string
  generatedAt: string
  unitPrices: { cpuHourly: number; memGbHourly: number; storageGbHourly: number }
  pricing: {
    estimate: true
    currency: string
    version: string
    effectiveDate: string | null
    source: string
    scope: string | null
    configured: boolean
  }
  items: CostItem[]
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

export function CostOverview() {
  const t = useT()
  const { data: costData, isLoading: costLoading, error: costError } = useQuery<CostResponse>({
    queryKey: ["cost", "cluster"],
    queryFn: async () => {
      const response = await fetch("/api/cost?scope=cluster")
      if (!response.ok) throw new Error("Cost data is unavailable")
      return response.json()
    },
    refetchInterval: 60_000,
  })

  const { data: trendData, isLoading: trendLoading, error: trendError } = useQuery<TrendResponse>({
    queryKey: ["cost-trend", "cluster", "cluster", 30],
    queryFn: async () => {
      const response = await fetch("/api/cost/trend?scope=cluster&id=cluster&days=30")
      if (!response.ok) throw new Error("Cost trend data is unavailable")
      return response.json()
    },
    refetchInterval: 300_000,
  })

  const item = costData?.items?.[0]
  const totalHourly = item?.totalHourly ?? 0
  const totalMonthly = item?.totalMonthly ?? 0
  const cpuHourly = item?.cpu.hourly ?? 0
  const memHourly = item?.memory.hourly ?? 0
  const storHourly = item?.storage.hourly ?? 0
  const currency = costData?.pricing.currency ?? "USD"
  const formatCurrency = (amount: number, maximumFractionDigits = 4) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits }).format(amount)

  const chartData = (trendData?.points ?? []).map((p) => ({
    date: p.date.slice(5), // MM-DD
    total: p.total,
  }))

  if (costError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        {t("cost.dataUnavailable")}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {costData?.notice && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
          {costData.notice}
        </div>
      )}
      {costData?.pricing && (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            {t("cost.estimateNotice")}
          </p>
          <p className="mt-1">
            {t("cost.pricingMetadata", {
              currency: costData.pricing.currency,
              version: costData.pricing.version,
              effectiveDate: costData.pricing.effectiveDate ?? t("cost.notConfigured"),
              source: costData.pricing.source,
              scope: costData.pricing.scope ?? t("cost.notConfigured"),
            })}
          </p>
          {!costData.pricing.configured && <p className="mt-1">{t("cost.developmentPricing")}</p>}
        </div>
      )}

      {/* 상단 요약 카드 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.hourlyCost")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {costLoading ? (
              <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            ) : (
              <p className="text-2xl font-bold text-foreground">
                {formatCurrency(totalHourly)}
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
            {costLoading ? (
              <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            ) : (
              <p className="text-2xl font-bold text-foreground">
                {formatCurrency(totalMonthly, 2)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.cpuCostHourly")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {costLoading ? (
              <div className="h-8 w-20 animate-pulse rounded bg-muted" />
            ) : (
              <div>
                <p className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
                  {formatCurrency(cpuHourly)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item?.cpu.cores.toFixed(3) ?? "0"} cores
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {t("cost.memoryCostHourly")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {costLoading ? (
              <div className="h-8 w-20 animate-pulse rounded bg-muted" />
            ) : (
              <div>
                <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(memHourly)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item?.memory.gb.toFixed(2) ?? "0"} GB
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Storage 카드 (스펙 §5.5 분해) */}
      {storHourly > 0 && (
        <div className="grid grid-cols-1">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {t("cost.storageCostHourly")}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xl font-bold text-orange-600 dark:text-orange-400">
                {formatCurrency(storHourly)}
              </p>
              <p className="text-xs text-muted-foreground">
                {item?.storage.gb.toFixed(2) ?? "0"} GB
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 30일 추이 라인차트 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-foreground">
            {t("cost.trendTitle30d")}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {trendLoading ? (
            <div className="h-52 flex items-center justify-center text-xs text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : trendError ? (
            <div className="h-52 flex items-center justify-center text-xs text-destructive">
              {t("cost.dataUnavailable")}
            </div>
          ) : chartData.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-xs text-muted-foreground">
              {trendData?.notice ?? t("cost.noTrendData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatCurrency(Number(v), 2)}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--card)",
                  }}
                  formatter={(value) => [`${formatCurrency(Number(value))}/h`, t("cost.cost")]}
                />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                  animationDuration={1000}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
