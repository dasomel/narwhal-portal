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

type GraphWindow = "1m" | "1h" | "1d" | "7d" | "30d"

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
  selectedId,
  onSelect,
}: {
  data: ServiceGraphResponse
  focusService?: string
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const COLS = Math.ceil(Math.sqrt(data.nodes.length)) || 1
  const NODE_W = 160
  const NODE_H = 50
  const GAP_X = 80
  const GAP_Y = 80

  // 선택 노드의 이웃 집합 — 선택 시 연결된 것만 선명하게, 나머지는 흐리게
  const neighborIds = new Set<string>()
  if (selectedId) {
    neighborIds.add(selectedId)
    for (const e of data.edges) {
      if (e.source === selectedId) neighborIds.add(e.destination)
      if (e.destination === selectedId) neighborIds.add(e.source)
    }
  }
  const isDimmedNode = (id: string) => selectedId !== null && !neighborIds.has(id)
  const isConnectedEdge = (s: string, d: string) =>
    selectedId === null || s === selectedId || d === selectedId

  const rfNodes = data.nodes.map((n, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const isFocused = (focusService && n.id === focusService) || n.id === selectedId
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
        cursor: "pointer",
        opacity: isDimmedNode(n.id) ? 0.2 : 1,
        transition: "opacity 0.2s",
      },
    }
  })

  // 트래픽 양 → 엣지 굵기 (√ 스케일, 1.5px ~ 6px)
  // L7(req/s)과 L4(bytes/s)는 단위 스케일이 달라 종류별로 정규화
  const maxRateByKind = { l7: 0.000001, l4: 0.000001 }
  for (const e of data.edges) {
    const k = edgeKind(e, data.metricKind)
    if (e.requestRate > maxRateByKind[k]) maxRateByKind[k] = e.requestRate
  }
  const rfEdges = data.edges.map((e, i) => {
    const connected = isConnectedEdge(e.source, e.destination)
    const k = edgeKind(e, data.metricKind)
    return {
      id: `e-${i}`,
      source: e.source,
      target: e.destination,
      style: {
        stroke: edgeColor(e.errorRate),
        strokeWidth: 1.5 + 4.5 * Math.sqrt(e.requestRate / maxRateByKind[k]),
        opacity: connected ? 0.9 : 0.07,
        transition: "opacity 0.2s",
      },
      // 흐려진 엣지는 라벨 숨김 (선택 노드 주변만 정보 표시)
      label: connected
        ? formatTraffic(e.requestRate, k) +
          (e.errorRate > 0.01 ? ` · ${(e.errorRate * 100).toFixed(1)}%` : "")
        : undefined,
      labelStyle: { fontSize: 10, fill: edgeColor(e.errorRate) },
      animated: connected && e.errorRate > 0.05,
    }
  })

  return (
    <div style={{ height: 500 }} className="flex-1 min-w-0 rounded border border-border overflow-hidden">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        attributionPosition="bottom-right"
        onNodeClick={(_, node) => onSelect(node.id === selectedId ? null : node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeBorderRadius={8}
          nodeStrokeWidth={3}
          maskColor="rgba(15, 23, 42, 0.12)"
          nodeColor={(n) => {
            if (n.id === selectedId) return "#1d4ed8"
            const node = data.nodes.find((nd) => nd.id === n.id)
            return statusColor(node?.status ?? "unknown")
          }}
          nodeStrokeColor={(n) => {
            const node = data.nodes.find((nd) => nd.id === n.id)
            return scoreTierBorderColor(node?.scoreTier)
          }}
        />
      </ReactFlow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 노드 상세 패널 (노드 클릭 시 우측 표시)
// ---------------------------------------------------------------------------

function formatRate(v: number): string {
  if (v >= 100) return v.toFixed(0)
  if (v >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

// requestRate 단위: L7=req/s, L4(istio_tcp_sent_bytes_total)=bytes/s
function formatTraffic(v: number, kind?: string): string {
  if (kind === "l4") {
    if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB/s`
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB/s`
    return `${v.toFixed(0)} B/s`
  }
  return `${formatRate(v)} req/s`
}

type GraphEdge = ServiceGraphResponse["edges"][number]

// 혼합(L7+L4) 그래프에서 엣지별 단위 결정
function edgeKind(e: GraphEdge, metricKind?: string): "l7" | "l4" {
  return (e.kind ?? (metricKind === "l4" ? "l4" : "l7")) as "l7" | "l4"
}

// kind가 섞인 엣지 합계를 "X req/s · Y KB/s" 형태로
function sumTraffic(edges: GraphEdge[], metricKind?: string): string {
  let l7 = 0
  let l4 = 0
  for (const e of edges) {
    if (edgeKind(e, metricKind) === "l4") l4 += e.requestRate
    else l7 += e.requestRate
  }
  const parts: string[] = []
  if (l7 > 0) parts.push(formatTraffic(l7, "l7"))
  if (l4 > 0) parts.push(formatTraffic(l4, "l4"))
  return parts.length > 0 ? parts.join(" · ") : formatTraffic(0, metricKind)
}

function NodeDetailPanel({
  data,
  nodeId,
  onClose,
  onSelect,
  t,
}: {
  data: ServiceGraphResponse
  nodeId: string
  onClose: () => void
  onSelect: (id: string) => void
  t: ReturnType<typeof useT>
}) {
  const node = data.nodes.find((n) => n.id === nodeId)
  const inbound = data.edges.filter((e) => e.destination === nodeId)
  const outbound = data.edges.filter((e) => e.source === nodeId)
  const totalIn = inbound.reduce((s, e) => s + e.requestRate, 0)
  const totalOut = outbound.reduce((s, e) => s + e.requestRate, 0)
  const isUnmapped = nodeId.startsWith("unmapped-pods:")
  const displayName = isUnmapped ? nodeId.replace("unmapped-pods:", "") : nodeId

  const statusKey: TranslationKey =
    node?.status === "healthy" ? "arch.healthy" : node?.status === "degraded" ? "arch.degraded" : "arch.unknown"

  function EdgeRow({ peer, rate, err, p95, kind }: { peer: string; rate: number; err: number; p95?: number | null; kind: "l7" | "l4" }) {
    return (
      <button
        type="button"
        onClick={() => onSelect(peer)}
        className="w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-muted/60 transition-colors"
      >
        <span className="font-mono text-xs truncate text-foreground" title={peer}>
          {peer.startsWith("unmapped-pods:") ? peer.replace("unmapped-pods:", "") + " *" : peer}
        </span>
        <span className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground font-mono">
          <span>{formatTraffic(rate, kind)}</span>
          <span style={{ color: edgeColor(err) }}>{(err * 100).toFixed(1)}%</span>
          {p95 != null && <span>{p95}ms</span>}
        </span>
      </button>
    )
  }

  return (
    <div className="w-80 shrink-0 rounded border border-border bg-card p-4 space-y-4 overflow-y-auto" style={{ maxHeight: 500 }}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-sm font-semibold text-foreground break-all">{displayName}</p>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm leading-none px-1">
          ✕
        </button>
      </div>

      {isUnmapped && (
        <p className="text-xs text-muted-foreground">{t("svcMap.detail.unmapped")}</p>
      )}

      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("svcMap.detail.namespace")}</span>
          <span className="font-mono text-foreground">{node?.namespace ?? "-"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("svcMap.detail.status")}</span>
          <span className="flex items-center gap-1.5 text-foreground">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: statusColor(node?.status ?? "unknown") }} />
            {t(statusKey)}
          </span>
        </div>
        {node?.scoreTier && node.scoreTier !== "none" && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("svcMap.detail.tier")}</span>
            <span className="capitalize" style={{ color: scoreTierBorderColor(node.scoreTier) }}>
              {node.scoreTier === "gold" ? "🥇" : node.scoreTier === "silver" ? "🥈" : "🥉"} {node.scoreTier}
            </span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("svcMap.detail.totalIn")}</span>
          <span className="font-mono text-foreground">{sumTraffic(inbound, data.metricKind)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("svcMap.detail.totalOut")}</span>
          <span className="font-mono text-foreground">{sumTraffic(outbound, data.metricKind)}</span>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          {t("svcMap.detail.inbound")} ({inbound.length})
        </p>
        {inbound.length === 0 ? (
          <p className="text-xs text-muted-foreground px-2">{t("svcMap.detail.noEdges")}</p>
        ) : (
          <div className="space-y-0.5">
            {inbound.map((e, i) => (
              <EdgeRow key={i} peer={e.source} rate={e.requestRate} err={e.errorRate} p95={e.p95LatencyMs} kind={edgeKind(e, data.metricKind)} />
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
          {t("svcMap.detail.outbound")} ({outbound.length})
        </p>
        {outbound.length === 0 ? (
          <p className="text-xs text-muted-foreground px-2">{t("svcMap.detail.noEdges")}</p>
        ) : (
          <div className="space-y-0.5">
            {outbound.map((e, i) => (
              <EdgeRow key={i} peer={e.destination} rate={e.requestRate} err={e.errorRate} p95={e.p95LatencyMs} kind={edgeKind(e, data.metricKind)} />
            ))}
          </div>
        )}
      </div>

      {!isUnmapped && (
        <a href={`/catalog/${encodeURIComponent(nodeId)}`} className="inline-block text-xs text-blue-500 hover:underline">
          {t("svcMap.detail.viewCatalog")}
        </a>
      )}
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 실시간 모드: 최근 1분 순간 rate를 5초마다 폴링 (Prometheus 스크레이프 주기상 준실시간)
  const [live, setLive] = useState(false)
  const effWindow: GraphWindow = live ? "1m" : window

  const queryKey = ["service-graph", effWindow, namespace]
  const { data, isLoading, error } = useQuery<ServiceGraphResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams({ window: effWindow })
      if (namespace) params.set("namespace", namespace)
      return fetch(`/api/service-graph?${params}`).then((r) => r.json())
    },
    refetchInterval: live ? 5_000 : 60_000,
    staleTime: live ? 0 : 30_000,
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
        {/* 윈도 셀렉터 (실시간 모드 중에는 잠금) */}
        <div className={`flex items-center gap-1 rounded-md border border-border p-1 ${live ? "opacity-40 pointer-events-none" : ""}`}>
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setWindow(opt.value)}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                !live && window === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>

        {/* 실시간 토글 */}
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          title={t("svcMap.liveHint")}
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
            live
              ? "border-red-500/60 bg-red-500/10 text-red-500"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${live ? "bg-red-500 animate-pulse" : "bg-muted-foreground/50"}`} />
          {t("svcMap.live")}
          {live && data?.generatedAt && (
            <span className="font-mono font-normal text-red-400/80">
              {new Date(data.generatedAt).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          )}
        </button>

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
          <div className="flex gap-4 items-stretch">
            <ReactFlowMap
              data={filteredData}
              focusService={focusService}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            {selectedId && (
              <NodeDetailPanel
                data={filteredData}
                nodeId={selectedId}
                onClose={() => setSelectedId(null)}
                onSelect={setSelectedId}
                t={t}
              />
            )}
          </div>
          {/* 통계 */}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{t("svcMap.stats.services")} <strong className="text-foreground">{filteredData.nodes.length}</strong></span>
            <span>{t("svcMap.stats.connections")} <strong className="text-foreground">{filteredData.edges.length}</strong></span>
            <span>
              {t("svcMap.stats.traffic")}{" "}
              <strong className="text-foreground font-mono">
                {sumTraffic(filteredData.edges, filteredData.metricKind)}
              </strong>
            </span>
            {filteredData.nodes.some((n) => n.id.startsWith("unmapped-pods:")) && (
              <Badge variant="outline" className="text-xs">
                {t("svcMap.stats.unmapped")}
              </Badge>
            )}
            {!selectedId && (
              <span className="ml-auto">{t("svcMap.detail.clickHint")}</span>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
