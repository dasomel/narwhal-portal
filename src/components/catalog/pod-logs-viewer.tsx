"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n-client"
import type { PodsResponse } from "@/app/api/pods/route"
import type { PodLogsResponse } from "@/app/api/pods/[namespace]/[pod]/logs/route"

const TAIL_LINES_OPTIONS = [100, 200, 500, 1000] as const
type TailLines = (typeof TAIL_LINES_OPTIONS)[number]

interface PodLogsViewerProps {
  namespace: string
  appName: string
}

export function PodLogsViewer({ namespace, appName }: PodLogsViewerProps) {
  const t = useT()
  const [selectedPod, setSelectedPod] = useState<string>("")
  const [selectedContainer, setSelectedContainer] = useState<string>("")
  const [tailLines, setTailLines] = useState<TailLines>(200)
  const [previous, setPrevious] = useState(false)

  const { data: podsData, isLoading: podsLoading } = useQuery<PodsResponse>({
    queryKey: ["pods", namespace, appName],
    queryFn: () =>
      fetch(
        `/api/pods?namespace=${encodeURIComponent(namespace)}&instance=${encodeURIComponent(appName)}`
      ).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch pods")
        return r.json()
      }),
    refetchInterval: 15_000,
  })

  const pods = podsData?.pods ?? []
  const currentPod = pods.find((p) => p.name === selectedPod)
  const containers = currentPod?.containers ?? []

  const effectiveContainer = selectedContainer || containers[0] || ""

  const {
    data: logsData,
    isLoading: logsLoading,
    error: logsError,
  } = useQuery<PodLogsResponse>({
    queryKey: ["pods-logs", namespace, selectedPod, effectiveContainer, tailLines, previous],
    queryFn: () => {
      const params = new URLSearchParams({
        tailLines: String(tailLines),
        previous: String(previous),
      })
      if (effectiveContainer) params.set("container", effectiveContainer)
      return fetch(
        `/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(selectedPod)}/logs?${params}`
      ).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch logs")
        return r.json()
      })
    },
    enabled: !!selectedPod,
    refetchInterval: 10_000,
  })

  function handlePodChange(value: string | null) {
    setSelectedPod(value ?? "")
    setSelectedContainer("")
  }

  function handleContainerChange(value: string | null) {
    setSelectedContainer(value ?? "")
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm">{t("logs.title")}</CardTitle>
          <div className="flex items-center gap-1 flex-wrap">
            <Badge variant="outline" className="text-[10px]">
              {t("logs.autoRefresh")} 10s
            </Badge>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap gap-2 mt-2">
          {/* Pod selector */}
          <Select value={selectedPod} onValueChange={handlePodChange} disabled={podsLoading}>
            <SelectTrigger className="h-8 text-xs w-52">
              <SelectValue placeholder={podsLoading ? t("common.loading") : t("logs.selectPod")} />
            </SelectTrigger>
            <SelectContent>
              {pods.map((p) => (
                <SelectItem key={p.name} value={p.name} className="text-xs">
                  <span>{p.name}</span>
                  <Badge
                    className={`ml-2 text-[10px] ${
                      p.status === "Running"
                        ? "bg-narwhal-success/15 text-narwhal-success"
                        : p.status === "Pending"
                          ? "bg-narwhal-warning/15 text-narwhal-warning"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {p.status}
                  </Badge>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Container selector */}
          {containers.length > 1 && (
            <Select
              value={selectedContainer || containers[0]}
              onValueChange={handleContainerChange}
            >
              <SelectTrigger className="h-8 text-xs w-44">
                <SelectValue placeholder={t("logs.selectContainer")} />
              </SelectTrigger>
              <SelectContent>
                {containers.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs font-mono">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Tail lines selector */}
          <Select
            value={String(tailLines)}
            onValueChange={(v) => setTailLines(Number(v ?? "200") as TailLines)}
          >
            <SelectTrigger className="h-8 text-xs w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TAIL_LINES_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">
                  {t("logs.tailLines")}: {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Previous toggle */}
          <button
            type="button"
            onClick={() => setPrevious((p) => !p)}
            className={`h-8 px-3 rounded-md border text-xs transition-colors ${
              previous
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:bg-muted/50"
            }`}
          >
            {t("logs.previous")}
          </button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {!selectedPod ? (
          <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
            {pods.length === 0 && !podsLoading
              ? `${appName}: No pods in namespace "${namespace}"`
              : t("logs.selectPod")}
          </div>
        ) : logsLoading ? (
          <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : logsError ? (
          <div className="flex items-center justify-center h-32 text-xs text-red-400">
            {t("common.loadError")}
          </div>
        ) : (
          <pre
            className="bg-foreground/95 text-background rounded-md p-3 text-[11px] font-mono leading-relaxed overflow-auto max-h-[500px] whitespace-pre-wrap break-all"
          >
            {logsData?.logs || t("logs.noLogs")}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
