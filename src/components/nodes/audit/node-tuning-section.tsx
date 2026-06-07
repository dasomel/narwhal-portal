"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  Network, ShieldAlert, Cpu, HardDrive, Wifi, Package, Layers, Activity, Server, Database,
} from "lucide-react"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import type {
  KernelParamInfo, KernelModuleInfo, ResourceLimitInfo, RequiredPackageInfo,
  DiskTuningInfo, LvmAutoExtendInfo, NicTuningInfo, RuntimeStatusInfo,
  CgroupInfo, SwapStatusInfo, PackageUpdate,
} from "@/lib/k8s-client"
import { pick } from "@/lib/i18n-utils"
import { ConfigHintRow } from "./config-hint-row"
import type { ConfigHint } from "./config-hint-row"
import { useAuditOpen } from "./audit-open-context"

interface NodeTuningSectionProps {
  locale: Locale
  nodeName?: string
  userRole?: string
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
}

const TH = "px-6 py-4 text-[10px] font-black text-muted-foreground uppercase tracking-widest whitespace-nowrap"
const TD = "px-6 py-4 text-sm"
const ROW = "hover:bg-muted/50/30 transition-all duration-200"
const TRIGGER_CLS = "hover:no-underline px-8 rounded-2xl transition-all py-6 group hover:bg-card shadow-sm"
const ITEM_CLS = "border-none bg-muted/50/30 rounded-2xl overflow-hidden shadow-inner ring-1 ring-border transition-all"
const TRIGGER_LABEL = "flex items-center gap-3 text-sm font-black text-foreground font-mono tracking-tight uppercase tracking-widest"
const TABLE_WRAP = "overflow-x-auto rounded-xl border border-border mx-6 mb-6"

// Render space-separated triplet/tuple values as labeled chunks so users can
// see min/default/max (or other components) at a glance.
function formatParamValue(param: string, value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return <>{value}</>

  // Known triplet labels
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

function healthBadge(ok: boolean, okLabel: string, badLabel: string) {
  return ok
    ? <Badge variant="outline" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest text-narwhal-success border-narwhal-success/30">{okLabel}</Badge>
    : <Badge variant="destructive" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest">{badLabel}</Badge>
}

function Check({ ok }: { ok: boolean }) {
  return <span className={ok ? "text-narwhal-success font-black" : "text-narwhal-danger font-black"}>{ok ? "✓" : "✗"}</span>
}

export function NodeTuningSection({
  locale, nodeName, userRole, kernelParams, kernelModules, resourceLimits, requiredPackages,
  diskTuning, lvmAutoExtend, nicTuning, runtimeStatus, cgroup, swap, packageUpdates,
}: NodeTuningSectionProps) {
  const t = (key: TranslationKey) => translate(locale, key)
  const applyCommon = { nodeName, userRole }
  const { openItems, toggleItem } = useAuditOpen()

  function itemProps(value: string) {
    return {
      value,
      id: `audit-item-${value}`,
      open: openItems.has(value),
      onOpenChange: (v: boolean) => toggleItem(value, v),
    }
  }

  return (
    <Card className="border border-border shadow-sm bg-card rounded-2xl overflow-hidden">
      <CardHeader className="py-5 px-8 border-b bg-muted/50/30">
        <CardTitle className="text-[11px] font-black flex items-center gap-2 text-foreground uppercase tracking-widest">
          <Server className="h-4 w-4 text-narwhal-accent" />
          {t("nodes.audit.nodeTuning")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pt-4 pb-4">
        <Accordion className="w-full space-y-3 px-4">

          {/* 1. Kernel Parameters */}
          <AccordionItem {...itemProps("kernel-params")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-blue-500 transition-colors`}>
                <Network className="h-4 w-4 text-blue-500" />
                {t("nodes.audit.kernel")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
                    {kernelParams.map((item, idx) => (
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
                          {healthBadge(
                            item.currentValue === item.recommendedValue,
                            t("nodes.audit.badge.healthy"),
                            t("nodes.audit.badge.tuneUp")
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 2. Kernel Modules */}
          <AccordionItem {...itemProps("kernel-modules")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-purple-500 transition-colors`}>
                <Layers className="h-4 w-4 text-purple-500" />
                {t("nodes.audit.kernelModules")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
                    {kernelModules.map((m, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 3. Resource Limits */}
          <AccordionItem {...itemProps("resource-limits")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-amber-500 transition-colors`}>
                <Cpu className="h-4 w-4 text-amber-500" />
                {t("nodes.audit.resourceLimits")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
                    {resourceLimits.map((r, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 4. Required Packages */}
          <AccordionItem {...itemProps("required-packages")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-green-600 transition-colors`}>
                <Package className="h-4 w-4 text-green-600" />
                {t("nodes.audit.requiredPackages")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
                    {requiredPackages.map((p, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 5. Disk Tuning */}
          <AccordionItem {...itemProps("disk-tuning")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-orange-500 transition-colors`}>
                <HardDrive className="h-4 w-4 text-orange-500" />
                {t("nodes.audit.diskTuning")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <div className="space-y-4 p-6">
                {diskTuning.map((d, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 6. LVM Auto-Extend */}
          <AccordionItem {...itemProps("lvm-auto-extend")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-yellow-600 transition-colors`}>
                <Database className="h-4 w-4 text-yellow-600" />
                {t("nodes.audit.lvmAutoExtend")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <div className="p-6">
                {lvmAutoExtend ? (
                  <div className="rounded-xl border border-border bg-muted/50/20 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-black text-foreground font-mono text-sm">{lvmAutoExtend.serviceName}</p>
                        <p className="text-muted-foreground text-xs mt-1">{pick(lvmAutoExtend.description, locale)}</p>
                      </div>
                      {healthBadge(lvmAutoExtend.enabled, t("nodes.audit.badge.enabled"), t("nodes.audit.badge.disabled"))}
                    </div>
                    {(lvmAutoExtend as LvmAutoExtendInfo & { configHint?: ConfigHint }).configHint && (
                      <ConfigHintRow
                        hint={(lvmAutoExtend as LvmAutoExtendInfo & { configHint: ConfigHint }).configHint}
                        applyTarget={{ kind: "service-enable", service: lvmAutoExtend.serviceName }}
                        {...applyCommon}
                      />
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm px-2">N/A</p>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 7. NIC Tuning */}
          <AccordionItem {...itemProps("nic-tuning")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-cyan-500 transition-colors`}>
                <Wifi className="h-4 w-4 text-cyan-500" />
                {t("nodes.audit.nicTuning")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <div className="space-y-4 p-6">
                {nicTuning.map((nic, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 8. Runtime Status */}
          <AccordionItem {...itemProps("runtime-status")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-emerald-500 transition-colors`}>
                <Activity className="h-4 w-4 text-emerald-500" />
                {t("nodes.audit.runtimeStatus")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
                    {runtimeStatus.map((r, idx) => (
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
            </AccordionContent>
          </AccordionItem>

          {/* 9. Cgroup */}
          <AccordionItem {...itemProps("cgroup")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-indigo-500 transition-colors`}>
                <Layers className="h-4 w-4 text-indigo-500" />
                {t("nodes.audit.cgroup")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <div className="p-6">
                <div className="rounded-xl border border-border bg-muted/50/20 p-5">
                  <div className="flex flex-wrap items-center gap-4">
                    <Badge
                      variant={cgroup.version === "v2" ? "outline" : "destructive"}
                      className={`font-black text-sm px-3 h-7 leading-none ${cgroup.version === "v2" ? "text-narwhal-success border-narwhal-success/30" : ""}`}
                    >
                      {cgroup.version}
                    </Badge>
                    <div className="flex flex-wrap gap-1.5">
                      {cgroup.controllers.map((c) => (
                        <Badge key={c} variant="outline" className="text-[10px] font-mono px-2 h-5 leading-none text-muted-foreground">{c}</Badge>
                      ))}
                    </div>
                  </div>
                  {(cgroup as CgroupInfo & { description?: string }).description && (
                    <p className="text-[11px] text-muted-foreground mt-2">{pick(cgroup.description, locale)}</p>
                  )}
                  {(cgroup as CgroupInfo & { configHint?: ConfigHint }).configHint && (
                    <ConfigHintRow hint={(cgroup as CgroupInfo & { configHint: ConfigHint }).configHint} />
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 10. Swap */}
          <AccordionItem {...itemProps("swap")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-rose-500 transition-colors`}>
                <Database className="h-4 w-4 text-rose-500" />
                {t("nodes.audit.swap")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <div className="p-6">
                <div className="rounded-xl border border-border bg-muted/50/20 p-5">
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Enabled</span>
                      {healthBadge(!swap.enabled, swap.enabled ? "On" : "Off", swap.enabled ? "On" : "Off")}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">fstab</span>
                      <Check ok={!swap.configuredInFstab} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Total</span>
                      <span className="font-black text-foreground">{swap.totalMb} MB</span>
                    </div>
                  </div>
                  {(swap as SwapStatusInfo & { description?: string }).description && (
                    <p className="text-[11px] text-muted-foreground mt-2">{pick(swap.description, locale)}</p>
                  )}
                  {(swap as SwapStatusInfo & { configHint?: ConfigHint }).configHint && (
                    <ConfigHintRow
                      hint={(swap as SwapStatusInfo & { configHint: ConfigHint }).configHint}
                      applyTarget={{ kind: "swap-off" }}
                      {...applyCommon}
                    />
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* 11. Security / CVE */}
          <AccordionItem {...itemProps("security")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-rose-600 transition-colors`}>
                <ShieldAlert className="h-4 w-4 text-rose-600" />
                {t("nodes.audit.security")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-6 pt-6 pb-6 space-y-4 border-t border-border bg-card">
              {packageUpdates.map((pkg, idx) => (
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
            </AccordionContent>
          </AccordionItem>

        </Accordion>
      </CardContent>
    </Card>
  )
}
