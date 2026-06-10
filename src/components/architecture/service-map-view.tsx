"use client"

// TODO(wrap-up): i18n — 현재 한국어 하드코딩, i18n.ts에 키 추가 필요

import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import type { ServiceGraphResponse } from "@/app/api/service-graph/route"
import type { TranslationKey } from "@/lib/i18n"
import { useT } from "@/lib/i18n-client"
import { Badge } from "@/components/ui/badge"
import { ReactFlow, Background, Controls, MiniMap } from "reactflow"
import "reactflow/dist/style.css"

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

type GraphWindow = "1h" | "1d" | "7d" | "30d"

interface Props {
  /** 외부에서 초기 네임스페이스 필터를 전달할 수 있음 */
  initialNamespace?: string
  /** 특정 서비스를 하이라이트 (architecture?focus= 파라미터 대응) */
  focusService?: string
}

// ---------------------------------------------------------------------------
// 스타일 헬퍼
// ---------------------------------------------------------------------------

const WINDOW_OPTIONS: { value: GraphWindow; key: TranslationKey }[] = [
  { value: "1h", key: "time.1h" },
  { value: "1d", key: "time.1d" },
  { value: "7d", key: "time.7d" },
  { value: "30d", key: "time.30d" },
]

function scoreTierBorderColor(tier?: string): string {
  switch (tier) {
    case "gold":
      return "#f59e0b"
    case "silver":
      return "#9ca3af"
    case "bronze":
      return "#b45309"
    default:
      return "#6b7280"
  }
}

function edgeColor(errorRate: number): string {
  if (errorRate > 0.05) return "#ef4444" // >5% 빨강
  if (errorRate > 0.01) return "#f59e0b" // 1–5% 노랑
  return "#22c55e" // 정상 초록
}

function statusColor(status: string): string {
  switch (status) {
    case "healthy":
      return "#22c55e"
    case "degraded":
      return "#ef4444"
    default:
      return "#9ca3af"
  }
}

// ---------------------------------------------------------------------------
// SVG 폴백 레이아웃 (ReactFlow 미설치 시)
// ---------------------------------------------------------------------------

function SvgFallbackMap({ data }: { data: ServiceGraphResponse }) {
  const { nodes, edges } = data

  const COLS = Math.ceil(Math.sqrt(nodes.length)) || 1
  const NODE_W = 120
  const NODE_H = 40
  const GAP_X = 60
  const GAP_Y = 60
  const PAD = 30

  const posMap = new Map<string, { x: number; y: number }>()
  nodes.forEach((n, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    posMap.set(n.id, {
      x: PAD + col * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
    })
  })

  const svgW = PAD * 2 + COLS * (NODE_W + GAP_X)
  const svgH = PAD * 2 + Math.ceil(nodes.length / COLS) * (NODE_H + GAP_Y)

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${svgW} ${svgH}`}
      className="min-h-[300px] rounded bg-muted/20"
    >
      {/* 엣지 */}
      {edges.map((e, i) => {
        const src = posMap.get(e.source)
        const dst = posMap.get(e.destination)
        if (!src || !dst) return null
        const x1 = src.x + NODE_W / 2
        const y1 = src.y + NODE_H / 2
        const x2 = dst.x + NODE_W / 2
        const y2 = dst.y + NODE_H / 2
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={edgeColor(e.errorRate)}
            strokeWidth={1.5}
            strokeOpacity={0.7}
            markerEnd="url(#arrow)"
          />
        )
      })}
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="#6b7280" />
        </marker>
      </defs>
      {/* 노드 */}
      {nodes.map((n) => {
        const pos = posMap.get(n.id)
        if (!pos) return null
        const label = n.id.startsWith("unmapped-pods:")
          ? n.id.replace("unmapped-pods:", "") + " *"
          : n.id
        return (
          <g key={n.id} transform={`translate(${pos.x},${pos.y})`}>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill="#1e293b"
              stroke={scoreTierBorderColor(n.scoreTier)}
              strokeWidth={2}
            />
            <circle cx={10} cy={NODE_H / 2} r={4} fill={statusColor(n.status)} />
            <text
              x={18}
              y={NODE_H / 2 + 4}
              fontSize={10}
              fill="#e2e8f0"
              className="font-mono"
            >
              {label.length > 14 ? label.slice(0, 13) + "…" : label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// ReactFlow 기반 맵
// ---------------------------------------------------------------------------

function ReactFlowMap({
  data,
  focusService,
}: {
  data: ServiceGraphResponse
  focusService?: string
}) {
  const COLS = Math.ceil(Math.sqrt(data.nodes.length)) || 1
  const NODE_W = 160
  const NODE_H = 50
  const GAP_X = 80
  const GAP_Y = 80

  const rfNodes = data.nodes.map((n, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const isFocused = focusService && n.id === focusService
    const isUnmapped = n.id.startsWith("unmapped-pods:")
    return {
      id: n.id,
      position: { x: col * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) },
      data: { label: isUnmapped ? n.id.replace("unmapped-pods:", "") + " *" : n.id },
      style: {
        background: isFocused ? "#1d4ed8" : "#1e293b",
        color: "#e2e8f0",
        border: `2px solid ${scoreTierBorderColor(n.scoreTier)}`,
        borderRadius: 8,
        fontSize: 12,
        width: NODE_W,
        height: NODE_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: isFocused ? "0 0 0 3px #3b82f6" : undefined,
      },
    }
  })

  const rfEdges = data.edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.destination,
    style: { stroke: edgeColor(e.errorRate), strokeWidth: 2 },
    label:
      e.errorRate > 0.01
        ? `${(e.errorRate * 100).toFixed(1)}%`
        : undefined,
    labelStyle: { fontSize: 10, fill: edgeColor(e.errorRate) },
    animated: e.errorRate > 0.05,
  }))

  return (
    <div style={{ height: 500 }} className="rounded border border-border overflow-hidden">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        attributionPosition="bottom-right"
      >
        <Background />
        <Controls />
        <MiniMap nodeColor={(n) => {
          const node = data.nodes.find((nd) => nd.id === n.id)
          return statusColor(node?.status ?? "unknown")
        }} />
      </ReactFlow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-10 text-center space-y-3">
      <p className="text-sm font-medium text-foreground">{t("svcMap.empty.title")}</p>
      <p className="text-xs text-muted-foreground">
        {t("svcMap.empty.desc1")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("svcMap.empty.desc2")}
      </p>
      <a
        href="/onboarding"
        className="inline-block text-xs text-blue-500 hover:underline"
      >
        {t("svcMap.empty.guide")}
      </a>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 메인 컴포넌트
// ---------------------------------------------------------------------------

export function ServiceMapView({ initialNamespace, focusService }: Props) {
  const t = useT()
  const [window, setWindow] = useState<GraphWindow>("7d")
  const [namespace, setNamespace] = useState(initialNamespace ?? "")
  const [errorThreshold, setErrorThreshold] = useState(5) // % 단위

  const queryKey = ["service-graph", window, namespace]
  const { data, isLoading, error } = useQuery<ServiceGraphResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ window })
      if (namespace) params.set("namespace", namespace)
      return fetch(`/api/service-graph?${params}`).then((r) => r.json())
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  // 에러율 임계 슬라이더 기반 엣지 필터
  const filteredData = useMemo(() => {
    if (!data) return null
    const threshold = errorThreshold / 100
    return {
      ...data,
      edges: data.edges.filter((e) => e.errorRate <= threshold || threshold >= 1),
    }
  }, [data, errorThreshold])

  // 네임스페이스 목록 — 서버가 내려주는 "필터 전 전체" 목록 사용.
  // (필터된 노드에서 추출하면 ns 선택 후 드롭다운이 이웃 ns만 남는 문제)
  const namespaces = useMemo(() => {
    if (!data) return []
    if (data.namespaces && data.namespaces.length > 0) return data.namespaces
    // 구버전 캐시 응답(namespaces 없음) 폴백
    return Array.from(new Set(data.nodes.map((n) => n.namespace)))
      .filter((ns) => ns && ns !== "unknown")
      .sort()
  }, [data])

  const isEmpty = !isLoading && !error && filteredData && filteredData.nodes.length === 0

  return (
    <div className="space-y-4">
      {/* 컨트롤 바 */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 윈도 셀렉터 */}
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setWindow(opt.value)}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                window === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>

        {/* 네임스페이스 필터 */}
        {namespaces.length > 0 && (
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="text-xs rounded border border-border bg-background px-2 py-1.5 text-foreground"
          >
            <option value="">{t("svcMap.allNamespaces")}</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        )}

        {/* 에러율 임계 슬라이더 */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("svcMap.errorThreshold")}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={errorThreshold}
            onChange={(e) => setErrorThreshold(Number(e.target.value))}
            className="w-24 accent-primary"
          />
          <span className="w-10 text-right font-mono">{errorThreshold}%</span>
        </div>

        {/* 범례 */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground ml-auto">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-green-500" /> {t("svcMap.legend.normal")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-yellow-500" /> {t("svcMap.legend.warning")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-red-500" /> {t("svcMap.legend.error")}
          </span>
        </div>
      </div>

      {/* notice 배너 (Prometheus 미응답 등) */}
      {data?.notice && (
        <div className="rounded border border-yellow-400/30 bg-yellow-400/10 px-4 py-2 text-xs text-yellow-600 dark:text-yellow-400">
          {data.notice}
        </div>
      )}

      {/* 그래프 영역 */}
      {isLoading ? (
        <div className="h-[500px] rounded border border-border bg-muted/20 animate-pulse" />
      ) : error ? (
        <div className="rounded border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {t("svcMap.loadError")}
        </div>
      ) : isEmpty ? (
        <EmptyState t={t} />
      ) : filteredData ? (
        <>
          <ReactFlowMap data={filteredData} focusService={focusService} />
          {/* 통계 */}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{t("svcMap.stats.services")} <strong className="text-foreground">{filteredData.nodes.length}</strong></span>
            <span>{t("svcMap.stats.connections")} <strong className="text-foreground">{filteredData.edges.length}</strong></span>
            {filteredData.nodes.some((n) => n.id.startsWith("unmapped-pods:")) && (
              <Badge variant="outline" className="text-xs">
                {t("svcMap.stats.unmapped")}
              </Badge>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
