"use client"

import { Badge } from "@/components/ui/badge"
import { ShieldAlert } from "lucide-react"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import { pick } from "@/lib/i18n-utils"
import type { MaybeLocalized } from "@/lib/i18n-utils"
import { ConfigHintRow } from "./config-hint-row"
import type { ConfigHint } from "./config-hint-row"
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

// Subset of systemStatus the detail renderer needs (matches SystemCheckSummary / sections).
export interface SystemStatusInput {
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

// ---- Shared style tokens (single source of truth; sections import from here) ----
export const TH = "px-6 py-4 text-[10px] font-black text-muted-foreground uppercase tracking-widest whitespace-nowrap"
export const TD = "px-6 py-4 text-sm"
export const ROW = "hover:bg-muted/50/30 transition-all duration-200"
export const TRIGGER_CLS = "hover:no-underline px-8 rounded-2xl transition-all py-6 group hover:bg-card shadow-sm"
export const ITEM_CLS = "border-none bg-muted/50/30 rounded-2xl overflow-hidden shadow-inner ring-1 ring-border transition-all"
export const TRIGGER_LABEL = "flex items-center gap-3 text-sm font-black text-foreground font-mono tracking-tight uppercase tracking-widest"
export const TABLE_WRAP = "overflow-x-auto rounded-xl border border-border mx-6 mb-6"

// ---- Shared helpers ----
export function healthBadge(ok: boolean, okLabel: string, badLabel: string) {
  return ok
    ? <Badge variant="outline" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest text-narwhal-success border-narwhal-success/30">{okLabel}</Badge>
    : <Badge variant="destructive" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest">{badLabel}</Badge>
}

export function Check({ ok }: { ok: boolean }) {
  return <span className={ok ? "text-narwhal-success font-black" : "text-narwhal-danger font-black"}>{ok ? "✓" : "✗"}</span>
}

// Render space-separated triplet/tuple values as labeled chunks.
export function formatParamValue(param: string, value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return <>{value}</>

  let labels: string[] | null = null
  if (parts.length === 3 && /tcp_(rmem|wmem)/.test(param)) {
    labels = ["min", "default", "max"]
  } else if (parts.length === 3 && /gc_thresh/.test(param)) {
    labels = ["low", "high", "max"]
  }

  return (
    <span className="inline-flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-baseline gap-1">
          {labels && (
            <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              {labels[i]}
            </span>
          )}
          <span className="font-mono">{p}</span>
          {i < parts.length - 1 && (
            <span className="text-muted-foreground/60 mx-0.5">·</span>
          )}
        </span>
      ))}
    </span>
  )
}

export function ConfigTable({ rows, locale, showAll = true }: {
  rows: Array<{ key: string; currentValue: string; recommendedValue: string; description: MaybeLocalized; impact: MaybeLocalized; configHint?: ConfigHint }>
  locale: Locale
  showAll?: boolean
}) {
  const t = (key: TranslationKey) => translate(locale, key)
  const visibleRows = showAll ? rows : rows.filter(r => r.currentValue !== r.recommendedValue)
  if (visibleRows.length === 0) {
    return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
  }
  return (
    <div className={TABLE_WRAP}>
      <table className="w-full text-left text-xs bg-card">
        <thead className="bg-muted/50 border-b border-border">
          <tr>
            <th className={TH}>Key</th>
            <th className={`${TH} text-center`}>{t("nodes.audit.actual")}</th>
            <th className={`${TH} text-center`}>{t("nodes.audit.target")}</th>
            <th className={TH}>Description / Impact</th>
            <th className={`${TH} text-right`}>{t("nodes.audit.health")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visibleRows.map((r, idx) => (
            <tr key={idx} className={ROW}>
              <td className={TD}>
                <p className="font-black font-mono text-foreground text-[12px]">{r.key}</p>
                {r.configHint && <ConfigHintRow hint={r.configHint} />}
              </td>
              <td className={`${TD} text-center font-bold text-foreground`}>{r.currentValue}</td>
              <td className={`${TD} text-center font-black text-blue-600`}>{r.recommendedValue}</td>
              <td className={`${TD} text-muted-foreground max-w-xs`}>
                <p>{pick(r.description, locale)}</p>
                {r.impact && <p className="text-[10px] text-narwhal-accent mt-0.5">{pick(r.impact, locale)}</p>}
              </td>
              <td className={`${TD} text-right`}>
                {healthBadge(
                  r.currentValue === r.recommendedValue,
                  t("nodes.audit.badge.healthy"),
                  t("nodes.audit.badge.tuneUp")
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface AuditItemDetailProps {
  id: string
  systemStatus: SystemStatusInput
  locale: Locale
  nodeName?: string
  userRole?: string
  showAll?: boolean
}

function NodeItemDetail({ id, systemStatus: s, locale, nodeName, userRole, showAll = true }: AuditItemDetailProps) {
  const t = (key: TranslationKey) => translate(locale, key)
  const applyCommon = { nodeName, userRole }

  switch (id) {
    case "kernel-params": {
      const visibleParams = showAll ? s.kernelParams : s.kernelParams.filter(p => p.currentValue !== p.recommendedValue)
      if (visibleParams.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className={TABLE_WRAP}>
          <table className="w-full text-left text-xs bg-card">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className={TH}>{t("nodes.audit.param")}</th>
                <th className={`${TH} text-center`}>{t("nodes.audit.actual")}</th>
                <th className={`${TH} text-center`}>{t("nodes.audit.target")}</th>
                <th className={`${TH} text-right`}>{t("nodes.audit.health")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {visibleParams.map((item, idx) => (
                <tr key={idx} className={ROW}>
                  <td className={TD}>
                    <p className="font-black text-foreground font-mono text-[12px]">{item.param}</p>
                    {item.description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xs">{pick(item.description, locale)}</p>
                    )}
                    {item.impact && (
                      <span className="text-[8px] font-black text-narwhal-accent uppercase tracking-widest bg-narwhal-accent-soft px-1.5 py-0.5 rounded border border-narwhal-accent/20 leading-none mt-1 inline-block">
                        {t("nodes.audit.impact")}: {pick(item.impact, locale)}
                      </span>
                    )}
                    {(item as KernelParamInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow
                        hint={(item as KernelParamInfo & { configHint: ConfigHint }).configHint}
                        applyTarget={{ kind: "kernel-param", param: item.param, value: item.recommendedValue }}
                        {...applyCommon}
                      />
                    )}
                  </td>
                  <td className={`${TD} text-center font-bold text-foreground`}>{formatParamValue(item.param, item.currentValue)}</td>
                  <td className={`${TD} text-center font-black text-blue-600`}>{formatParamValue(item.param, item.recommendedValue)}</td>
                  <td className={`${TD} text-right`}>
                    {healthBadge(item.currentValue === item.recommendedValue, t("nodes.audit.badge.healthy"), t("nodes.audit.badge.tuneUp"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "kernel-modules": {
      const visibleModules = showAll ? s.kernelModules : s.kernelModules.filter(m => m.required && !m.loaded)
      if (visibleModules.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className={TABLE_WRAP}>
          <table className="w-full text-left text-xs bg-card">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className={TH}>Module</th>
                <th className={`${TH} text-center`}>Required</th>
                <th className={`${TH} text-center`}>Status</th>
                <th className={TH}>Purpose</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {visibleModules.map((m, idx) => (
                <tr key={idx} className={ROW}>
                  <td className={TD}>
                    <p className="font-black font-mono text-foreground text-[12px]">{m.name}</p>
                    {(m as KernelModuleInfo & { description?: string }).description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{pick(m.purpose, locale)}</p>
                    )}
                    {(m as KernelModuleInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow
                        hint={(m as KernelModuleInfo & { configHint: ConfigHint }).configHint}
                        applyTarget={{ kind: "kernel-module", module: m.name }}
                        {...applyCommon}
                      />
                    )}
                  </td>
                  <td className={`${TD} text-center`}><Check ok={m.required} /></td>
                  <td className={`${TD} text-center`}>
                    {healthBadge(m.loaded, t("nodes.audit.badge.loaded"), t("nodes.audit.badge.missing"))}
                  </td>
                  <td className={`${TD} text-muted-foreground`}>{pick(m.purpose, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "resource-limits": {
      const visibleLimits = showAll ? s.resourceLimits : s.resourceLimits.filter(r => r.currentValue !== r.recommendedValue)
      if (visibleLimits.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className={TABLE_WRAP}>
          <table className="w-full text-left text-xs bg-card">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className={TH}>Name</th>
                <th className={`${TH} text-center`}>Scope</th>
                <th className={`${TH} text-center`}>Current</th>
                <th className={`${TH} text-center`}>Recommended</th>
                <th className={`${TH} text-right`}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {visibleLimits.map((r, idx) => (
                <tr key={idx} className={ROW}>
                  <td className={TD}>
                    <p className="font-black font-mono text-foreground text-[12px]">{r.name}</p>
                    {r.description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{pick(r.description, locale)}</p>
                    )}
                    {(r as ResourceLimitInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow
                        hint={(r as ResourceLimitInfo & { configHint: ConfigHint }).configHint}
                        applyTarget={{ kind: "ulimit", name: r.name, scope: r.scope, value: r.recommendedValue }}
                        {...applyCommon}
                      />
                    )}
                  </td>
                  <td className={`${TD} text-center`}>
                    <Badge variant="outline" className="text-[9px] font-bold uppercase">{r.scope}</Badge>
                  </td>
                  <td className={`${TD} text-center font-bold text-foreground`}>{r.currentValue}</td>
                  <td className={`${TD} text-center font-black text-blue-600`}>{r.recommendedValue}</td>
                  <td className={`${TD} text-right`}>
                    {healthBadge(r.currentValue === r.recommendedValue, t("nodes.audit.badge.healthy"), t("nodes.audit.badge.tuneUp"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "required-packages": {
      const visiblePackages = showAll ? s.requiredPackages : s.requiredPackages.filter(p => !p.installed)
      if (visiblePackages.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className={TABLE_WRAP}>
          <table className="w-full text-left text-xs bg-card">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className={TH}>Package</th>
                <th className={TH}>Purpose</th>
                <th className={`${TH} text-right`}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {visiblePackages.map((p, idx) => (
                <tr key={idx} className={ROW}>
                  <td className={TD}>
                    <p className="font-black font-mono text-foreground text-[12px]">{p.name}</p>
                    {(p as RequiredPackageInfo & { description?: string }).description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{pick(p.purpose, locale)}</p>
                    )}
                    {(p as RequiredPackageInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow
                        hint={(p as RequiredPackageInfo & { configHint: ConfigHint }).configHint}
                        applyTarget={{ kind: "package", name: p.name }}
                        {...applyCommon}
                      />
                    )}
                  </td>
                  <td className={`${TD} text-muted-foreground`}>{pick(p.purpose, locale)}</td>
                  <td className={`${TD} text-right`}>
                    {healthBadge(p.installed, t("nodes.audit.badge.installed"), t("nodes.audit.badge.missing"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "disk-tuning": {
      const visibleDisks = showAll ? s.diskTuning : s.diskTuning.filter(d =>
        d.ioScheduler.current !== d.ioScheduler.recommended ||
        d.readAheadKb.current !== d.readAheadKb.recommended ||
        !d.noatimeConfigured
      )
      if (visibleDisks.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="space-y-4 p-6">
          {visibleDisks.map((d, idx) => (
            <div key={idx} className="rounded-xl border border-border bg-muted/50/20 p-5">
              <p className="font-black text-foreground font-mono text-sm">{d.device}</p>
              {(d as DiskTuningInfo & { description?: string }).description && (
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-1">{pick(d.description, locale)}</p>
              )}
              {(d as DiskTuningInfo & { configHint?: ConfigHint }).configHint && (
                <ConfigHintRow
                  hint={(d as DiskTuningInfo & { configHint: ConfigHint }).configHint}
                  applyTarget={{ kind: "tuning-script", script: "05-disk-tuning.sh" }}
                  {...applyCommon}
                />
              )}
              <div className="mt-3">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">I/O Scheduler</span>
                  <span className="font-black text-foreground">
                    {d.ioScheduler.current}
                    {d.ioScheduler.current !== d.ioScheduler.recommended && (
                      <span className="text-blue-500 ml-1">→ {d.ioScheduler.recommended}</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">Read-ahead KB</span>
                  <span className="font-black text-foreground">
                    {d.readAheadKb.current}
                    {d.readAheadKb.current !== d.readAheadKb.recommended && (
                      <span className="text-blue-500 ml-1">→ {d.readAheadKb.recommended}</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">FS Type</span>
                  <span className="font-bold text-foreground uppercase">{d.fsType}</span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">noatime</span>
                  <Check ok={d.noatimeConfigured} />
                </div>
                {d.fsType === "xfs" && (
                  <div className="flex justify-between border-b border-border/50 pb-2">
                    <span className="text-muted-foreground font-bold">XFS prjquota</span>
                    <Check ok={d.xfsPrjquota} />
                  </div>
                )}
                <div className="flex flex-wrap gap-1 col-span-2 pt-1">
                  <span className="text-muted-foreground font-bold text-[10px] self-center mr-1">Mount opts:</span>
                  {d.mountOptions.map((opt) => (
                    <Badge key={opt} variant="outline" className="text-[9px] font-mono px-1.5 h-4 leading-none">{opt}</Badge>
                  ))}
                </div>
              </div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    case "lvm-auto-extend": {
      if (!showAll && s.lvmAutoExtend && s.lvmAutoExtend.enabled) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="p-6">
          {s.lvmAutoExtend ? (
            <div className="rounded-xl border border-border bg-muted/50/20 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-black text-foreground font-mono text-sm">{s.lvmAutoExtend.serviceName}</p>
                  <p className="text-muted-foreground text-xs mt-1">{pick(s.lvmAutoExtend.description, locale)}</p>
                </div>
                {healthBadge(s.lvmAutoExtend.enabled, t("nodes.audit.badge.enabled"), t("nodes.audit.badge.disabled"))}
              </div>
              {(s.lvmAutoExtend as LvmAutoExtendInfo & { configHint?: ConfigHint }).configHint && (
                <ConfigHintRow
                  hint={(s.lvmAutoExtend as LvmAutoExtendInfo & { configHint: ConfigHint }).configHint}
                  applyTarget={{ kind: "service-enable", service: s.lvmAutoExtend.serviceName }}
                  {...applyCommon}
                />
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm px-2">N/A</p>
          )}
        </div>
      )
    }

    case "nic-tuning": {
      const visibleNics = showAll ? s.nicTuning : s.nicTuning.filter(n =>
        n.ringBufferRx.current !== n.ringBufferRx.recommended ||
        n.ringBufferTx.current !== n.ringBufferTx.recommended
      )
      if (visibleNics.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="space-y-4 p-6">
          {visibleNics.map((nic, idx) => (
            <div key={idx} className="rounded-xl border border-border bg-muted/50/20 p-5">
              <p className="font-black text-foreground font-mono text-sm">{nic.interface}</p>
              {(nic as NicTuningInfo & { description?: string }).description && (
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-1">{pick(nic.description, locale)}</p>
              )}
              {(nic as NicTuningInfo & { configHint?: ConfigHint }).configHint && (
                <ConfigHintRow
                  hint={(nic as NicTuningInfo & { configHint: ConfigHint }).configHint}
                  applyTarget={{
                    kind: "ethtool",
                    iface: nic.interface,
                    rx: nic.ringBufferRx.recommended,
                    tx: nic.ringBufferTx.recommended,
                  }}
                  {...applyCommon}
                />
              )}
              <div className="mt-3">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">Ring Buffer RX</span>
                  <span className="font-black text-foreground">
                    {nic.ringBufferRx.current}
                    {nic.ringBufferRx.current !== nic.ringBufferRx.recommended && (
                      <span className="text-blue-500 ml-1">→ {nic.ringBufferRx.recommended}</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">Ring Buffer TX</span>
                  <span className="font-black text-foreground">
                    {nic.ringBufferTx.current}
                    {nic.ringBufferTx.current !== nic.ringBufferTx.recommended && (
                      <span className="text-blue-500 ml-1">→ {nic.ringBufferTx.recommended}</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">Coalescing RX</span>
                  <span className="font-bold text-foreground">{nic.coalescingUsec.rx} usec</span>
                </div>
                <div className="flex justify-between border-b border-border/50 pb-2">
                  <span className="text-muted-foreground font-bold">Coalescing TX</span>
                  <span className="font-bold text-foreground">{nic.coalescingUsec.tx} usec</span>
                </div>
                <div className="col-span-2 flex gap-2 pt-1">
                  <span className="text-muted-foreground font-bold text-[10px] self-center mr-1">Offloading:</span>
                  {(["tso", "gso", "gro"] as const).map((key) => (
                    <Badge
                      key={key}
                      variant="outline"
                      className={`text-[9px] font-black px-1.5 h-4 leading-none uppercase ${nic.offloading[key] ? "text-narwhal-success border-narwhal-success/30" : "text-narwhal-danger border-narwhal-danger/30"}`}
                    >
                      {key} {nic.offloading[key] ? "✓" : "✗"}
                    </Badge>
                  ))}
                </div>
              </div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    case "runtime-status": {
      const visibleRuntimes = showAll ? s.runtimeStatus : s.runtimeStatus.filter(r => !r.active)
      if (visibleRuntimes.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className={TABLE_WRAP}>
          <table className="w-full text-left text-xs bg-card">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className={TH}>Runtime</th>
                <th className={`${TH} text-center`}>Version</th>
                <th className={`${TH} text-right`}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {visibleRuntimes.map((r, idx) => (
                <tr key={idx} className={ROW}>
                  <td className={TD}>
                    <p className="font-black font-mono text-foreground text-[12px]">{r.name}</p>
                    {(r as RuntimeStatusInfo & { description?: string }).description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{pick(r.description, locale)}</p>
                    )}
                    {(r as RuntimeStatusInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow hint={(r as RuntimeStatusInfo & { configHint: ConfigHint }).configHint} />
                    )}
                  </td>
                  <td className={`${TD} text-center text-muted-foreground`}>{r.version}</td>
                  <td className={`${TD} text-right`}>
                    {healthBadge(r.active, t("nodes.audit.badge.active"), t("nodes.audit.badge.inactive"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "cgroup": {
      if (!showAll && s.cgroup.version === "v2") {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="p-6">
          <div className="rounded-xl border border-border bg-muted/50/20 p-5">
            <div className="flex flex-wrap items-center gap-4">
              <Badge
                variant={s.cgroup.version === "v2" ? "outline" : "destructive"}
                className={`font-black text-sm px-3 h-7 leading-none ${s.cgroup.version === "v2" ? "text-narwhal-success border-narwhal-success/30" : ""}`}
              >
                {s.cgroup.version}
              </Badge>
              <div className="flex flex-wrap gap-1.5">
                {s.cgroup.controllers.map((c) => (
                  <Badge key={c} variant="outline" className="text-[10px] font-mono px-2 h-5 leading-none text-muted-foreground">{c}</Badge>
                ))}
              </div>
            </div>
            {(s.cgroup as CgroupInfo & { description?: string }).description && (
              <p className="text-[11px] text-muted-foreground mt-2">{pick(s.cgroup.description, locale)}</p>
            )}
            {(s.cgroup as CgroupInfo & { configHint?: ConfigHint }).configHint && (
              <ConfigHintRow hint={(s.cgroup as CgroupInfo & { configHint: ConfigHint }).configHint} />
            )}
          </div>
        </div>
      )
    }

    case "swap": {
      if (!showAll && !s.swap.enabled) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="p-6">
          <div className="rounded-xl border border-border bg-muted/50/20 p-5">
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Enabled</span>
                {healthBadge(!s.swap.enabled, s.swap.enabled ? "On" : "Off", s.swap.enabled ? "On" : "Off")}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">fstab</span>
                <Check ok={!s.swap.configuredInFstab} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Total</span>
                <span className="font-black text-foreground">{s.swap.totalMb} MB</span>
              </div>
            </div>
            {(s.swap as SwapStatusInfo & { description?: string }).description && (
              <p className="text-[11px] text-muted-foreground mt-2">{pick(s.swap.description, locale)}</p>
            )}
            {(s.swap as SwapStatusInfo & { configHint?: ConfigHint }).configHint && (
              <ConfigHintRow
                hint={(s.swap as SwapStatusInfo & { configHint: ConfigHint }).configHint}
                applyTarget={{ kind: "swap-off" }}
                {...applyCommon}
              />
            )}
          </div>
        </div>
      )
    }

    case "security":
      return (
        <div className="px-6 pt-6 pb-6 space-y-4">
          {s.packageUpdates.map((pkg, idx) => (
            <div key={idx} className="flex gap-6 p-6 border border-border bg-card rounded-2xl hover:bg-muted/50/10 transition-all shadow-sm border-l-[6px] border-l-rose-500/80">
              <div className="h-10 w-10 rounded-xl bg-rose-50 flex items-center justify-center shrink-0">
                <ShieldAlert className="h-5 w-5 text-rose-500" />
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex justify-between items-start gap-2">
                  <h4 className="text-sm font-black text-foreground leading-tight">{pkg.name}
                    <span className="text-[11px] text-muted-foreground font-bold ml-3 font-mono">{pkg.currentVersion} → {pkg.targetVersion}</span>
                  </h4>
                  <Badge variant="destructive" className="font-black text-[8px] px-2 h-5 leading-none uppercase shrink-0">{t("nodes.audit.badge.urgent")}</Badge>
                </div>
                <p className="text-xs font-bold text-muted-foreground leading-relaxed">{pick(pkg.reason, locale)}</p>
                {pkg.link && (
                  <a href={pkg.link} target="_blank" rel="noreferrer" className="text-[10px] font-black text-blue-600 inline-flex items-center gap-1.5 hover:underline underline-offset-4">
                    {t("nodes.audit.cveReport")}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )

    default:
      return null
  }
}

function K8sItemDetail({ id, systemStatus: s, locale, showAll = true }: AuditItemDetailProps) {
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const { clusterVersion, kubeletConfig, kubeProxyConfig, containerdConfig, cniPlugin, controlPlaneFlags } = s.k8sTuning

  switch (id) {
    case "cluster-version":
      return (
        <div className="p-6">
          <div className="rounded-xl border border-border bg-muted/50/20 p-5">
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">Kubernetes</span>
                <span className="font-black text-foreground font-mono">{clusterVersion.kubernetes}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">Cluster Age</span>
                <span className="font-black text-foreground font-mono">{clusterVersion.clusterAge}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">Patch Current</span>
                {healthBadge(clusterVersion.isPatchCurrent, t("nodes.audit.badge.healthy"), t("nodes.audit.badge.tuneUp"))}
              </div>
            </div>
            {(clusterVersion as typeof clusterVersion & { description?: string }).description && (
              <p className="text-[11px] text-muted-foreground mt-2">{pick(clusterVersion.description, locale)}</p>
            )}
            {(clusterVersion as typeof clusterVersion & { configHint?: ConfigHint }).configHint && (
              <ConfigHintRow hint={(clusterVersion as typeof clusterVersion & { configHint: ConfigHint }).configHint} />
            )}
          </div>
        </div>
      )

    case "cni-plugin":
      return (
        <div className="p-6">
          <div className="rounded-xl border border-border bg-muted/50/20 p-5 space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="font-black text-foreground text-base">{cniPlugin.name}</span>
              <Badge variant="outline" className="font-mono text-[10px]">{cniPlugin.version}</Badge>
              <Badge variant="outline" className="text-[10px] font-bold uppercase">{cniPlugin.mode}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={cniPlugin.kubeProxyReplacement ? "outline" : "destructive"}
                className={`text-[9px] font-black uppercase ${cniPlugin.kubeProxyReplacement ? "text-narwhal-success border-narwhal-success/30" : ""}`}
              >
                kube-proxy replacement {cniPlugin.kubeProxyReplacement ? "✓" : "✗"}
              </Badge>
              <Badge
                variant={cniPlugin.hubbleEnabled ? "outline" : "destructive"}
                className={`text-[9px] font-black uppercase ${cniPlugin.hubbleEnabled ? "text-narwhal-success border-narwhal-success/30" : ""}`}
              >
                Hubble {cniPlugin.hubbleEnabled ? "✓" : "✗"}
              </Badge>
              {cniPlugin.encryptionMode && (
                <Badge variant="outline" className="text-[9px] font-bold uppercase text-narwhal-accent border-narwhal-accent/30">
                  encryption: {cniPlugin.encryptionMode}
                </Badge>
              )}
              {cniPlugin.ipamMode && (
                <Badge variant="outline" className="text-[9px] font-bold uppercase">
                  ipam: {cniPlugin.ipamMode}
                </Badge>
              )}
            </div>
            {cniPlugin.description && (
              <p className="text-xs text-muted-foreground leading-relaxed border-l-2 border-border pl-3">{pick(cniPlugin.description, locale)}</p>
            )}
            {(cniPlugin as typeof cniPlugin & { configHint?: ConfigHint }).configHint && (
              <ConfigHintRow hint={(cniPlugin as typeof cniPlugin & { configHint: ConfigHint }).configHint} />
            )}
          </div>
        </div>
      )

    case "kubelet-config":
      return <ConfigTable rows={kubeletConfig} locale={locale} showAll={showAll} />

    case "kubeproxy-config":
      return cniPlugin.kubeProxyReplacement ? (
        <div className="px-8 py-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            <span className="font-semibold text-foreground">{cniPlugin.name}</span>
            {" "}— {t("nodes.audit.kubeProxyReplacedBy", { cni: cniPlugin.name })}
          </p>
          <p className="mt-2 text-xs">
            {t("nodes.audit.kubeProxyReplacedHint")}
          </p>
        </div>
      ) : (
        <ConfigTable rows={kubeProxyConfig} locale={locale} showAll={showAll} />
      )

    case "containerd-config":
      return <ConfigTable rows={containerdConfig} locale={locale} showAll={showAll} />

    case "cp-flags": {
      const visibleFlags = showAll ? controlPlaneFlags : controlPlaneFlags.filter(f => f.currentValue !== f.recommendedValue)
      const cpFlagsByComponent: Record<string, typeof controlPlaneFlags> = {}
      for (const f of visibleFlags) {
        if (!cpFlagsByComponent[f.component]) cpFlagsByComponent[f.component] = []
        cpFlagsByComponent[f.component].push(f)
      }
      if (visibleFlags.length === 0) {
        return <p className="px-8 py-4 text-[11px] font-black uppercase tracking-widest text-narwhal-success">{t("nodes.audit.allPassed")}</p>
      }
      return (
        <div className="space-y-6 p-6">
          {Object.entries(cpFlagsByComponent).map(([component, flags]) => (
            <div key={component}>
              <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mb-2 px-1">{component}</p>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-xs bg-card">
                  <thead className="bg-muted/50 border-b border-border">
                    <tr>
                      <th className={TH}>Flag</th>
                      <th className={`${TH} text-center`}>{t("nodes.audit.actual")}</th>
                      <th className={`${TH} text-center`}>{t("nodes.audit.target")}</th>
                      <th className={TH}>Description / Impact</th>
                      <th className={`${TH} text-right`}>{t("nodes.audit.health")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {flags.map((f, idx) => (
                      <tr key={idx} className={ROW}>
                        <td className={TD}>
                          <p className="font-black font-mono text-foreground text-[12px]">{f.flag}</p>
                          {(f as typeof f & { configHint?: ConfigHint }).configHint && (
                            <ConfigHintRow hint={(f as typeof f & { configHint: ConfigHint }).configHint} />
                          )}
                        </td>
                        <td className={`${TD} text-center font-bold text-foreground font-mono`}>{f.currentValue}</td>
                        <td className={`${TD} text-center font-black text-blue-600 font-mono`}>{f.recommendedValue}</td>
                        <td className={`${TD} text-muted-foreground max-w-xs`}>
                          <p>{pick(f.description, locale)}</p>
                          {f.impact && <p className="text-[10px] text-narwhal-accent mt-0.5">{pick(f.impact, locale)}</p>}
                        </td>
                        <td className={`${TD} text-right`}>
                          {healthBadge(f.currentValue === f.recommendedValue, t("nodes.audit.badge.healthy"), t("nodes.audit.badge.tuneUp"))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )
    }

    default:
      return null
  }
}

const K8S_IDS = new Set([
  "cluster-version",
  "cni-plugin",
  "kubelet-config",
  "kubeproxy-config",
  "containerd-config",
  "cp-flags",
])

/**
 * Renders the detail body for a single audit item by id. Used both inside the
 * accordion sections (NodeTuningSection / K8sTuningSection) and inline inside
 * the SystemCheckSummary action-item list, guaranteeing identical content.
 */
export function AuditItemDetail(props: AuditItemDetailProps) {
  return K8S_IDS.has(props.id) ? <K8sItemDetail {...props} /> : <NodeItemDetail {...props} />
}
