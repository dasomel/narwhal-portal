"use client"

import { useState, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PodLogsViewer } from "@/components/catalog/pod-logs-viewer"
import type { PodListResponse, PodDetail, ResourceEventsResponse, PodSummary } from "./types"
import type { ImageVulnReport } from "@/types/security"

interface ResourceDetailDrawerProps {
  namespace: string
  app?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPodName?: string
}

function relativeTime(ts: string, tFn: any): string {
  if (!ts) return "—"
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return tFn("audit.justNow") || "방금"
  if (mins < 60) return tFn("audit.minsAgo", { mins }) || `${mins}m 전`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tFn("audit.hrsAgo", { hrs }) || `${hrs}h 전`
  return tFn("audit.daysAgo", { days: Math.floor(hrs / 24) }) || `${Math.floor(hrs / 24)}d 전`
}

function formatTs(ts: string, locale: string): string {
  if (!ts) return "—"
  return new Date(ts).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function getPhaseBadgeClass(phase: string): string {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
    case "Pending":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
    case "Failed":
      return "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30"
    default:
      return "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30"
  }
}

function ContainerVulnSummary({ image }: { image: string }) {
  const t = useT()
  const { data, isLoading, isError } = useQuery<ImageVulnReport>({
    queryKey: ["governance-container-vuln", image],
    queryFn: () =>
      fetch(`/api/security/vulnerabilities?image=${encodeURIComponent(image)}`).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch vulnerabilities")
        return r.json()
      }),
    enabled: !!image,
    staleTime: 60_000,
  })

  if (isLoading) {
    return <span className="animate-pulse text-xs text-muted-foreground">{t("common.loading")}</span>
  }

  if (isError || !data || !data.summary) {
    return <span className="text-xs text-muted-foreground">{t("governance.detail.security.noVuln")}</span>
  }

  const summary = data.summary
  const hasFindings = Object.values(summary).some((count) => count > 0)

  if (!hasFindings) {
    return <span className="text-xs text-emerald-600 font-medium">{t("security.vuln.noFindings") || "No vulnerabilities"}</span>
  }

  return (
    <div className="flex gap-1.5 flex-wrap items-center">
      {Object.entries(summary).map(([severity, count]) => {
        if (count === 0) return null
        let badgeColor = "bg-zinc-100 text-zinc-800 border-zinc-200"
        if (severity === "Critical") badgeColor = "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/45 dark:text-rose-400 dark:border-rose-800/40"
        else if (severity === "High") badgeColor = "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/45 dark:text-orange-400 dark:border-orange-850/40"
        else if (severity === "Medium") badgeColor = "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/45 dark:text-amber-400 dark:border-amber-800/40"
        else if (severity === "Low") badgeColor = "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/45 dark:text-blue-400 dark:border-blue-800/40"

        return (
          <Badge key={severity} variant="outline" className={`text-[10px] font-semibold px-1.5 py-0.5 ${badgeColor}`}>
            {severity}: {count}
          </Badge>
        )
      })}
    </div>
  )
}

export function ResourceDetailDrawer({ namespace, app, open, onOpenChange, initialPodName }: ResourceDetailDrawerProps) {
  const t = useT()
  const locale = useLocale()
  const [selectedPodName, setSelectedPodName] = useState<string | null>(null)

  const { data: podListData, isLoading: listLoading, error: listError } = useQuery<PodListResponse>({
    queryKey: ["governance-pods", namespace, app],
    queryFn: () => {
      const url = `/api/k8s/pods?namespace=${encodeURIComponent(namespace)}` + (app ? `&app=${encodeURIComponent(app)}` : "")
      return fetch(url).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch pod list")
        return r.json()
      })
    },
    enabled: open && !!namespace,
    refetchInterval: 15_000,
  })

  const { data: podDetail, isLoading: detailLoading } = useQuery<PodDetail>({
    queryKey: ["governance-pod-detail", namespace, selectedPodName],
    queryFn: () => {
      return fetch(`/api/k8s/resource?kind=Pod&namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(selectedPodName!)}`).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch pod detail")
        return r.json()
      })
    },
    enabled: open && !!namespace && !!selectedPodName,
    refetchInterval: 10_000,
  })

  const { data: eventsData, isLoading: eventsLoading } = useQuery<ResourceEventsResponse>({
    queryKey: ["governance-pod-events", namespace, selectedPodName],
    queryFn: () => {
      return fetch(`/api/k8s/events?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(selectedPodName!)}`).then((r) => {
        if (!r.ok) throw new Error("Failed to fetch pod events")
        return r.json()
      })
    },
    enabled: open && !!namespace && !!selectedPodName,
    refetchInterval: 15_000,
  })

  const pods = podListData?.pods ?? []
  const events = eventsData?.events ?? []

  useEffect(() => {
    if (open && initialPodName) {
      const podExists = pods.some((p) => p.name === initialPodName)
      if (podExists) {
        setSelectedPodName(initialPodName)
      }
    }
  }, [open, initialPodName, pods])

  function handleOpenChange(newOpen: boolean) {
    onOpenChange(newOpen)
    if (!newOpen) {
      setSelectedPodName(null)
    }
  }

  const effectiveAppName = app || podDetail?.labels?.["app.kubernetes.io/instance"] || podDetail?.labels?.["app"] || ""

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* sheet.tsx 기본의 data-[side=right]:sm:max-w-sm 상한을 !important로 무력화 — 내용 잘림 방지 */}
      <SheetContent className="w-full sm:!w-[56rem] sm:!max-w-[92vw] overflow-y-auto overflow-x-hidden flex flex-col h-full p-6">
        <SheetHeader className="border-b pb-4 mb-4 shrink-0">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-lg font-bold text-foreground">
              {t("governance.detail.title")}
            </SheetTitle>
            {app && (
              <Badge variant="secondary" className="font-mono text-xs">
                {app}
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-xs">
              {namespace}
            </Badge>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          {listLoading ? (
            <div className="h-48 flex items-center justify-center">
              <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
            </div>
          ) : listError ? (
            <div className="h-48 flex items-center justify-center">
              <span className="text-sm text-rose-500 font-medium">{t("common.loadError")}</span>
            </div>
          ) : !selectedPodName ? (
            // Pod List Mode
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{t("governance.detail.pods")}</h3>
                <span className="text-xs text-muted-foreground">Total: {pods.length}</span>
              </div>

              {pods.length === 0 ? (
                <div className="h-32 bg-muted/20 border border-dashed rounded-lg flex items-center justify-center">
                  <span className="text-sm text-muted-foreground">{t("governance.detail.empty")}</span>
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden bg-card">
                  <Table>
                    <TableHeader className="bg-muted/30">
                      <TableRow>
                        <TableHead className="py-2.5">{t("governance.detail.podName")}</TableHead>
                        <TableHead className="py-2.5 text-center w-16">{t("governance.detail.ready")}</TableHead>
                        <TableHead className="py-2.5 text-center w-16">{t("governance.detail.restarts")}</TableHead>
                        <TableHead className="py-2.5 w-24">{t("governance.detail.node")}</TableHead>
                        <TableHead className="py-2.5 text-right w-20">{t("governance.detail.age")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pods.map((pod) => (
                        <TableRow
                          key={pod.name}
                          onClick={() => setSelectedPodName(pod.name)}
                          className="cursor-pointer hover:bg-muted/40 transition-colors"
                        >
                          <TableCell className="py-2.5 font-medium" title={pod.name}>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-xs text-foreground font-semibold break-all">{pod.name}</span>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className={`w-2 h-2 rounded-full shrink-0 ${
                                  pod.phase === "Running" ? "bg-emerald-500" :
                                  pod.phase === "Pending" ? "bg-amber-400" : "bg-rose-500"
                                }`} />
                                <span className="text-[10px] text-muted-foreground">{pod.phase}</span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-2.5 text-center text-xs text-muted-foreground tabular-nums">
                            {pod.ready}
                          </TableCell>
                          <TableCell className="py-2.5 text-center text-xs text-muted-foreground tabular-nums">
                            {pod.restarts}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs text-muted-foreground font-mono whitespace-nowrap" title={pod.node}>
                            {pod.node || "—"}
                          </TableCell>
                          <TableCell className="py-2.5 text-right text-xs text-muted-foreground whitespace-nowrap">
                            {relativeTime(pod.age, t)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : (
            // Pod Detail Mode (Tabs: 개요, 로그, 보안, 이벤트)
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedPodName(null)}
                  className="h-8 text-xs flex items-center gap-1.5"
                >
                  ← {t("governance.detail.back")}
                </Button>
                <div className="flex items-center gap-2 max-w-[70%]">
                  <span className="text-sm font-semibold text-foreground truncate" title={selectedPodName}>
                    {selectedPodName}
                  </span>
                  {podDetail && (
                    <Badge variant="outline" className={`text-xs ${getPhaseBadgeClass(podDetail.phase)}`}>
                      {podDetail.phase}
                    </Badge>
                  )}
                </div>
              </div>

              {detailLoading || !podDetail ? (
                <div className="h-48 flex items-center justify-center">
                  <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
                </div>
              ) : (
                <Tabs defaultValue="overview" className="w-full">
                  <TabsList className="grid grid-cols-4 w-full h-9 mb-4">
                    <TabsTrigger value="overview" className="text-xs">
                      {t("governance.detail.tab.overview")}
                    </TabsTrigger>
                    <TabsTrigger value="logs" className="text-xs">
                      {t("governance.detail.tab.logs")}
                    </TabsTrigger>
                    <TabsTrigger value="security" className="text-xs">
                      {t("governance.detail.tab.security")}
                    </TabsTrigger>
                    <TabsTrigger value="events" className="text-xs">
                      {t("governance.detail.tab.events")}
                    </TabsTrigger>
                  </TabsList>

                  {/* Overview Tab */}
                  <TabsContent value="overview" className="space-y-4 outline-none">
                    <div className="bg-muted/20 border rounded-lg p-4 space-y-2.5">
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.overview.status")}</span>
                        <span className="font-semibold text-foreground">{podDetail.phase}</span>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.overview.podIP")}</span>
                        <span className="font-mono text-foreground">{podDetail.podIP || "—"}</span>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.node")}</span>
                        <span className="font-mono text-foreground">{podDetail.node || "—"}</span>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.overview.qos")}</span>
                        <span className="font-mono text-foreground">{podDetail.qosClass || "—"}</span>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.overview.sa")}</span>
                        <span className="font-mono text-foreground">{podDetail.serviceAccount || "—"}</span>
                      </div>
                      <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                        <span className="text-muted-foreground">{t("governance.detail.overview.createdAt")}</span>
                        <span className="text-foreground">{formatTs(podDetail.createdAt, locale)}</span>
                      </div>
                      {podDetail.owner && (
                        <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border/40 text-xs">
                          <span className="text-muted-foreground">{t("governance.detail.overview.owner")}</span>
                          <span className="font-mono text-foreground">{podDetail.owner.kind} / {podDetail.owner.name}</span>
                        </div>
                      )}
                      <div>
                        <span className="text-[11px] text-muted-foreground block mb-1">{t("governance.detail.overview.labels")}</span>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(podDetail.labels || {}).map(([k, v]) => (
                            <Badge key={k} variant="outline" className="text-[10px] font-normal font-mono bg-background">
                              {k}={v}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Containers List */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-foreground">{t("governance.detail.overview.containers")}</h4>
                      <div className="border rounded-lg overflow-hidden bg-card">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow>
                              <TableHead className="py-2 text-xs">{t("governance.detail.overview.containerName")}</TableHead>
                              <TableHead className="py-2 text-xs">{t("governance.detail.overview.image")}</TableHead>
                              <TableHead className="py-2 text-xs text-center w-12">{t("governance.detail.ready")}</TableHead>
                              <TableHead className="py-2 text-xs text-center w-12">{t("governance.detail.restarts")}</TableHead>
                              <TableHead className="py-2 text-xs w-20">{t("governance.detail.overview.state")}</TableHead>
                              <TableHead className="py-2 text-xs text-right w-24">{t("governance.detail.overview.limits")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {podDetail.containers.map((c) => (
                              <TableRow key={c.name} className="hover:bg-muted/10">
                                <TableCell className="py-2 text-xs font-medium font-mono">{c.name}</TableCell>
                                <TableCell className="py-2 text-xs font-mono break-all" title={c.image}>
                                  {c.image}
                                </TableCell>
                                <TableCell className="py-2 text-center text-xs">
                                  <span className={c.ready ? "text-emerald-500 font-semibold" : "text-rose-500 font-semibold"}>
                                    {c.ready ? "✓" : "✗"}
                                  </span>
                                </TableCell>
                                <TableCell className="py-2 text-center text-xs tabular-nums">{c.restarts}</TableCell>
                                <TableCell className="py-2 text-xs">
                                  <Badge variant="outline" className={`text-[10px] font-normal ${
                                    c.state.startsWith("running") ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                    "bg-rose-50 text-rose-700 border-rose-200"
                                  }`}>
                                    {c.state}
                                  </Badge>
                                </TableCell>
                                <TableCell className="py-2 text-right text-[10px] font-mono text-muted-foreground whitespace-pre">
                                  {`Req: ${c.requests.cpu || "0"}/${c.requests.memory || "0"}\nLim: ${c.limits.cpu || "0"}/${c.limits.memory || "0"}`}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>

                    {/* Conditions List */}
                    {podDetail.conditions && podDetail.conditions.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-foreground">{t("governance.detail.overview.conditions")}</h4>
                        <div className="border rounded-lg overflow-hidden bg-card">
                          <Table>
                            <TableHeader className="bg-muted/20">
                              <TableRow>
                                <TableHead className="py-2 text-xs">{t("governance.detail.overview.conditionType")}</TableHead>
                                <TableHead className="py-2 text-xs w-20">{t("governance.detail.overview.conditionStatus")}</TableHead>
                                <TableHead className="py-2 text-xs">{t("governance.detail.overview.conditionMessage")}</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {podDetail.conditions.map((cond) => (
                                <TableRow key={cond.type} className="hover:bg-muted/10">
                                  <TableCell className="py-2 text-xs font-medium font-mono">{cond.type}</TableCell>
                                  <TableCell className="py-2 text-xs">
                                    <Badge variant="outline" className={`text-[10px] ${
                                      cond.status === "True" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                      cond.status === "False" ? "bg-rose-50 text-rose-700 border-rose-200" :
                                      "bg-zinc-50 text-zinc-700 border-zinc-200"
                                    }`}>
                                      {cond.status}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="py-2 text-xs text-muted-foreground max-w-xs truncate" title={cond.message || cond.reason}>
                                    {cond.message || cond.reason || "—"}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  {/* Logs Tab */}
                  <TabsContent value="logs" className="outline-none">
                    <PodLogsViewer namespace={namespace} appName={effectiveAppName} />
                  </TabsContent>

                  {/* Security Tab */}
                  <TabsContent value="security" className="space-y-4 outline-none">
                    <div className="space-y-3">
                      <h4 className="text-xs font-semibold text-foreground">{t("governance.detail.security.vulnSummary")}</h4>
                      <div className="space-y-3">
                        {podDetail.containers.map((c) => (
                          <div key={c.name} className="p-3 border rounded-lg bg-card space-y-1.5">
                            <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                              <span className="font-semibold text-foreground font-mono">{c.name}</span>
                              <span className="text-muted-foreground text-[10px] font-mono truncate max-w-[280px]" title={c.image}>
                                {c.image}
                              </span>
                            </div>
                            <ContainerVulnSummary image={c.image} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </TabsContent>

                  {/* Events Tab */}
                  <TabsContent value="events" className="outline-none">
                    {eventsLoading ? (
                      <div className="h-32 flex items-center justify-center">
                        <span className="text-xs text-muted-foreground animate-pulse">{t("common.loading")}</span>
                      </div>
                    ) : events.length === 0 ? (
                      <div className="h-32 bg-muted/20 border border-dashed rounded-lg flex flex-col items-center justify-center gap-1 px-4 text-center">
                        <span className="text-sm text-muted-foreground">{t("governance.detail.events.empty")}</span>
                        <span className="text-xs text-muted-foreground/70">{t("governance.detail.events.retentionHint")}</span>
                      </div>
                    ) : (
                      <div className="border rounded-lg overflow-hidden bg-card">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow>
                              <TableHead className="py-2 text-xs w-16">{t("governance.detail.events.type")}</TableHead>
                              <TableHead className="py-2 text-xs w-24">{t("governance.detail.events.reason")}</TableHead>
                              <TableHead className="py-2 text-xs">{t("governance.detail.events.message")}</TableHead>
                              <TableHead className="py-2 text-xs text-center w-12">{t("governance.detail.events.count")}</TableHead>
                              <TableHead className="py-2 text-xs text-right w-24">{t("governance.detail.events.lastSeen")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {events.map((e, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/10">
                                <TableCell className="py-2 text-xs">
                                  <Badge variant="outline" className={`text-[10px] font-normal ${
                                    e.type === "Warning" ? "bg-rose-50 text-rose-700 border-rose-200" :
                                    "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  }`}>
                                    {e.type}
                                  </Badge>
                                </TableCell>
                                <TableCell className="py-2 text-xs font-semibold font-mono">{e.reason}</TableCell>
                                <TableCell className="py-2 text-xs text-muted-foreground max-w-[200px] truncate" title={e.message}>
                                  {e.message}
                                </TableCell>
                                <TableCell className="py-2 text-center text-xs tabular-nums text-muted-foreground">{e.count}</TableCell>
                                <TableCell className="py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                                  {relativeTime(e.lastSeen, t)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
