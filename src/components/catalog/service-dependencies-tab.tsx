"use client"

// TODO(wrap-up): i18n — 현재 한국어 하드코딩, i18n.ts에 키 추가 필요

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useT } from "@/lib/i18n-client"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ServiceGraphDetailResponse } from "@/app/api/service-graph/[svc]/route"

interface Props {
  /** 서비스 이름 (ArgoCD application name) */
  serviceName: string
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function formatRate(rate: number): string {
  if (rate < 0.01) return "<0.01 req/s"
  if (rate < 1) return `${(rate * 1000).toFixed(0)} req/min`
  return `${rate.toFixed(2)} req/s`
}

function formatErrorRate(rate: number): string {
  if (rate === 0) return "0%"
  return `${(rate * 100).toFixed(2)}%`
}

function formatLatency(ms?: number | null): string {
  if (ms == null) return "—"
  return `${Math.round(ms)} ms`
}

function ErrorRateBadge({ rate }: { rate: number }) {
  if (rate > 0.05)
    return (
      <Badge variant="destructive" className="text-xs px-1.5 py-0">
        {formatErrorRate(rate)}
      </Badge>
    )
  if (rate > 0.01)
    return (
      <Badge
        variant="outline"
        className="text-xs px-1.5 py-0 border-yellow-400/50 text-yellow-600 dark:text-yellow-400"
      >
        {formatErrorRate(rate)}
      </Badge>
    )
  return (
    <span className="text-xs text-muted-foreground">{formatErrorRate(rate)}</span>
  )
}

// ---------------------------------------------------------------------------
// 섹션 테이블
// ---------------------------------------------------------------------------

function InboundTable({
  rows,
}: {
  rows: ServiceGraphDetailResponse["inbound"]
}) {
  const t = useT()
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        {t("svcDep.noInbound")}
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("svcDep.sourceService")}</TableHead>
          <TableHead className="w-32">{t("svcDep.requestRate")}</TableHead>
          <TableHead className="w-24">{t("svcDep.errorRate")}</TableHead>
          <TableHead className="w-24">{t("svcDep.p95Latency")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.source}>
            <TableCell className="font-mono text-sm">
              <Link
                href={`/catalog/${row.source}`}
                className="text-blue-500 hover:underline"
              >
                {row.source}
              </Link>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatRate(row.requestRate)}
            </TableCell>
            <TableCell>
              <ErrorRateBadge rate={row.errorRate} />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatLatency(row.p95LatencyMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function OutboundTable({
  rows,
}: {
  rows: ServiceGraphDetailResponse["outbound"]
}) {
  const t = useT()
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-4 text-center">
        {t("svcDep.noOutbound")}
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("svcDep.targetService")}</TableHead>
          <TableHead className="w-32">{t("svcDep.requestRate")}</TableHead>
          <TableHead className="w-24">{t("svcDep.errorRate")}</TableHead>
          <TableHead className="w-24">{t("svcDep.p95Latency")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.destination}>
            <TableCell className="font-mono text-sm">
              <Link
                href={`/catalog/${row.destination}`}
                className="text-blue-500 hover:underline"
              >
                {row.destination}
              </Link>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatRate(row.requestRate)}
            </TableCell>
            <TableCell>
              <ErrorRateBadge rate={row.errorRate} />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatLatency(row.p95LatencyMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---------------------------------------------------------------------------
// 메인 컴포넌트
// ---------------------------------------------------------------------------

export function ServiceDependenciesTab({ serviceName }: Props) {
  const t = useT()
  const { data, isLoading, error } = useQuery<ServiceGraphDetailResponse>({
    queryKey: ["service-dependencies", serviceName],
    queryFn: () =>
      fetch(`/api/service-graph/${encodeURIComponent(serviceName)}?window=7d`).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch dependencies")
        return r.json()
      }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-4 bg-muted rounded animate-pulse w-32" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="h-8 bg-muted rounded animate-pulse" />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <p className="text-sm text-red-500">{t("svcDep.loadError")}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* notice 배너 */}
      {data?.notice && (
        <div className="rounded border border-yellow-400/30 bg-yellow-400/10 px-4 py-2 text-xs text-yellow-600 dark:text-yellow-400">
          {data.notice}
        </div>
      )}

      {/* Istio 미적용 안내 */}
      {data && data.inbound.length === 0 && data.outbound.length === 0 && !data.notice && (
        <div className="rounded border border-dashed border-border bg-muted/20 p-6 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("svcDep.noTraffic")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("svcDep.noIstioDesc")}
          </p>
        </div>
      )}

      {/* 인바운드 섹션 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {t("svcDep.inboundCall")}
            {data && (
              <Badge variant="secondary" className="text-xs">
                {data.inbound.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data ? <InboundTable rows={data.inbound} /> : null}
        </CardContent>
      </Card>

      {/* 아웃바운드 섹션 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {t("svcDep.outboundCall")}
            {data && (
              <Badge variant="secondary" className="text-xs">
                {data.outbound.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data ? <OutboundTable rows={data.outbound} /> : null}
        </CardContent>
      </Card>

      {/* 전체 맵 링크 */}
      <div className="text-right">
        <Link
          href={`/architecture?view=services&focus=${encodeURIComponent(serviceName)}`}
          className="text-xs text-blue-500 hover:underline"
        >
          {t("svcDep.viewInMap")}
        </Link>
        {/* TODO(wrap-up): architecture page의 Services 토글 통합 후 view=services 쿼리 파라미터 처리 */}
      </div>
    </div>
  )
}
