"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ClipboardCheck, ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import type {
  KernelParamInfo,
  KernelModuleInfo,
  ResourceLimitInfo,
  RequiredPackageInfo,
  DiskTuningInfo,
  LvmAutoExtendInfo,
  NicTuningInfo,
  RuntimeStatusInfo,
  CgroupInfo,
  SwapStatusInfo,
  K8sTuningInfo,
  PackageUpdate,
} from "@/lib/k8s-client"
import { useAuditOpen } from "./audit-open-context"

// The subset of systemStatus this component needs.
interface SystemStatusInput {
  kernelParams: KernelParamInfo[]
  kernelModules: KernelModuleInfo[]
  resourceLimits: ResourceLimitInfo[]
  requiredPackages: RequiredPackageInfo[]
  diskTuning: DiskTuningInfo[]
  lvmAutoExtend: LvmAutoExtendInfo | null
  nicTuning: NicTuningInfo[]
  runtimeStatus: RuntimeStatusInfo[]
  cgroup: CgroupInfo
  swap: SwapStatusInfo
  packageUpdates: PackageUpdate[]
  k8sTuning: K8sTuningInfo
}

interface Props {
  systemStatus: SystemStatusInput
  locale: Locale
}

/** Returns the set of accordion item IDs that have at least one action-needed item. */
function computeActionItems(s: SystemStatusInput): Set<string> {
  const actionIds = new Set<string>()

  // kernelParams — action when current !== recommended
  if (s.kernelParams.some(p => p.currentValue !== p.recommendedValue)) {
    actionIds.add("kernel-params")
  }

  // kernelModules — action when required module is not loaded
  if (s.kernelModules.some(m => m.required && !m.loaded)) {
    actionIds.add("kernel-modules")
  }

  // resourceLimits — action when current !== recommended
  if (s.resourceLimits.some(r => r.currentValue !== r.recommendedValue)) {
    actionIds.add("resource-limits")
  }

  // requiredPackages — action when not installed
  if (s.requiredPackages.some(p => !p.installed)) {
    actionIds.add("required-packages")
  }

  // diskTuning — action when ioScheduler, readAhead, or noatime mismatch
  if (s.diskTuning.some(d =>
    d.ioScheduler.current !== d.ioScheduler.recommended ||
    d.readAheadKb.current !== d.readAheadKb.recommended ||
    !d.noatimeConfigured
  )) {
    actionIds.add("disk-tuning")
  }

  // lvmAutoExtend — action when present but not enabled
  if (s.lvmAutoExtend !== null && !s.lvmAutoExtend.enabled) {
    actionIds.add("lvm-auto-extend")
  }

  // nicTuning — action when ring buffers mismatch
  if (s.nicTuning.some(n =>
    n.ringBufferRx.current !== n.ringBufferRx.recommended ||
    n.ringBufferTx.current !== n.ringBufferTx.recommended
  )) {
    actionIds.add("nic-tuning")
  }

  // runtimeStatus — action when not active
  if (s.runtimeStatus.some(r => !r.active)) {
    actionIds.add("runtime-status")
  }

  // cgroup — action when not v2
  if (s.cgroup.version !== "v2") {
    actionIds.add("cgroup")
  }

  // swap — action when enabled
  if (s.swap.enabled) {
    actionIds.add("swap")
  }

  // packageUpdates — any pending update is action
  if (s.packageUpdates.length > 0) {
    actionIds.add("security")
  }

  // k8sTuning.kubeletConfig
  if (s.k8sTuning.kubeletConfig.some(c => c.currentValue !== c.recommendedValue)) {
    actionIds.add("kubelet-config")
  }

  // k8sTuning.kubeProxyConfig
  if (s.k8sTuning.kubeProxyConfig.some(c => c.currentValue !== c.recommendedValue)) {
    actionIds.add("kubeproxy-config")
  }

  // k8sTuning.containerdConfig
  if (s.k8sTuning.containerdConfig.some(c => c.currentValue !== c.recommendedValue)) {
    actionIds.add("containerd-config")
  }

  // k8sTuning.clusterVersion
  if (!s.k8sTuning.clusterVersion.isPatchCurrent) {
    actionIds.add("cluster-version")
  }

  return actionIds
}

function computeCounts(s: SystemStatusInput): { ok: number; action: number; total: number } {
  let ok = 0
  let action = 0

  // kernelParams
  for (const p of s.kernelParams) {
    if (p.currentValue === p.recommendedValue) ok++; else action++
  }
  // kernelModules (required only)
  for (const m of s.kernelModules) {
    if (m.required) { if (m.loaded) ok++; else action++ }
  }
  // resourceLimits
  for (const r of s.resourceLimits) {
    if (r.currentValue === r.recommendedValue) ok++; else action++
  }
  // requiredPackages
  for (const p of s.requiredPackages) {
    if (p.installed) ok++; else action++
  }
  // diskTuning
  for (const d of s.diskTuning) {
    const ioOk = d.ioScheduler.current === d.ioScheduler.recommended
    const raOk = d.readAheadKb.current === d.readAheadKb.recommended
    const noatimeOk = d.noatimeConfigured
    if (ioOk && raOk && noatimeOk) ok++; else action++
  }
  // lvmAutoExtend
  if (s.lvmAutoExtend !== null) {
    if (s.lvmAutoExtend.enabled) ok++; else action++
  }
  // nicTuning
  for (const n of s.nicTuning) {
    const rxOk = n.ringBufferRx.current === n.ringBufferRx.recommended
    const txOk = n.ringBufferTx.current === n.ringBufferTx.recommended
    if (rxOk && txOk) ok++; else action++
  }
  // runtimeStatus
  for (const r of s.runtimeStatus) {
    if (r.active) ok++; else action++
  }
  // cgroup
  if (s.cgroup.version === "v2") ok++; else action++
  // swap
  if (!s.swap.enabled) ok++; else action++
  // packageUpdates
  for (const _ of s.packageUpdates) { action++ }
  // k8sTuning
  for (const c of s.k8sTuning.kubeletConfig) {
    if (c.currentValue === c.recommendedValue) ok++; else action++
  }
  for (const c of s.k8sTuning.kubeProxyConfig) {
    if (c.currentValue === c.recommendedValue) ok++; else action++
  }
  for (const c of s.k8sTuning.containerdConfig) {
    if (c.currentValue === c.recommendedValue) ok++; else action++
  }
  if (s.k8sTuning.clusterVersion.isPatchCurrent) ok++; else action++

  return { ok, action, total: ok + action }
}

export function SystemCheckSummary({ systemStatus, locale }: Props) {
  const t = (key: TranslationKey) => translate(locale, key)
  const { ok, action, total } = computeCounts(systemStatus)
  const isHealthy = action === 0
  const { filterActive, activateFilter, resetFilter } = useAuditOpen()

  function handleActionClick() {
    if (action === 0) return
    if (filterActive) {
      // Second click: toggle off — restore defaults
      resetFilter()
    } else {
      // First click: show ONLY action-needed items, close the rest
      const ids = computeActionItems(systemStatus)
      activateFilter(ids)
      // Scroll to the first action item after state update settles
      requestAnimationFrame(() => {
        const firstId = ids.values().next().value
        if (firstId) {
          const el = document.getElementById(`audit-item-${firstId}`)
          el?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      })
    }
  }

  return (
    <Card className="border border-border shadow-sm bg-card rounded-2xl overflow-hidden">
      <CardHeader className="py-5 px-8 border-b bg-muted/50/30">
        <CardTitle className="text-[11px] font-black flex items-center gap-2 text-foreground uppercase tracking-widest">
          <ClipboardCheck className="h-4 w-4 text-narwhal-accent" />
          {t("nodes.audit.summary.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-8 py-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {/* Total Checks */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none">
              {t("nodes.audit.summary.total")}
            </span>
            <span className="text-3xl font-black text-foreground leading-none">{total}</span>
          </div>

          {/* OK */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none">
              {t("nodes.audit.summary.ok")}
            </span>
            <span className="text-3xl font-black text-narwhal-success leading-none">{ok}</span>
          </div>

          {/* Action Needed — toggleable button when action > 0 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none">
              {t("nodes.audit.summary.action")}
            </span>
            {action > 0 ? (
              <button
                type="button"
                onClick={handleActionClick}
                aria-pressed={filterActive}
                aria-label={t("nodes.audit.summary.action")}
                className={`group inline-flex items-center gap-2 w-fit rounded-lg px-3 py-1.5 -ml-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 ${
                  filterActive
                    ? "bg-rose-500/10 border border-rose-500/40 text-rose-500"
                    : "border border-transparent hover:border-rose-500/30 hover:bg-rose-500/5 text-rose-500"
                }`}
              >
                <span className="text-3xl font-black leading-none">{action}</span>
                {filterActive
                  ? <ChevronsDownUp className="h-4 w-4 shrink-0 opacity-70" />
                  : <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50 group-hover:opacity-80 transition-opacity" />
                }
              </button>
            ) : (
              <span className="text-3xl font-black leading-none text-narwhal-success">
                {action}
              </span>
            )}
          </div>

          {/* Overall Health */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none">
              {t("nodes.audit.summary.health")}
            </span>
            <div className="mt-1">
              {isHealthy ? (
                <Badge
                  variant="outline"
                  className="font-black text-[10px] h-6 px-3 leading-none uppercase tracking-widest text-narwhal-success border-narwhal-success/30"
                >
                  {t("nodes.audit.summary.healthy")}
                </Badge>
              ) : (
                <Badge
                  variant="destructive"
                  className="font-black text-[10px] h-6 px-3 leading-none uppercase tracking-widest"
                >
                  {t("nodes.audit.summary.needsAction")}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
