"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Boxes, Settings, Activity, Network, Cpu } from "lucide-react"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import type { K8sTuningInfo } from "@/lib/k8s-client"
import { pick } from "@/lib/i18n-utils"
import type { MaybeLocalized } from "@/lib/i18n-utils"
import { ConfigHintRow } from "./config-hint-row"
import type { ConfigHint } from "./config-hint-row"
import { useAuditOpen } from "./audit-open-context"

interface K8sTuningSectionProps {
  locale: Locale
  k8sTuning: K8sTuningInfo
}

const TH = "px-6 py-4 text-[10px] font-black text-muted-foreground uppercase tracking-widest whitespace-nowrap"
const TD = "px-6 py-4 text-sm"
const ROW = "hover:bg-muted/50/30 transition-all duration-200"
const TRIGGER_CLS = "hover:no-underline px-8 rounded-2xl transition-all py-6 group hover:bg-card shadow-sm"
const ITEM_CLS = "border-none bg-muted/50/30 rounded-2xl overflow-hidden shadow-inner ring-1 ring-border transition-all"
const TRIGGER_LABEL = "flex items-center gap-3 text-sm font-black text-foreground font-mono tracking-tight uppercase tracking-widest"
const TABLE_WRAP = "overflow-x-auto rounded-xl border border-border mx-6 mb-6"

function healthBadge(ok: boolean, okLabel: string, badLabel: string) {
  return ok
    ? <Badge variant="outline" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest text-narwhal-success border-narwhal-success/30">{okLabel}</Badge>
    : <Badge variant="destructive" className="font-black text-[9px] h-5 px-2 leading-none uppercase tracking-widest">{badLabel}</Badge>
}

function ConfigTable({ rows, locale }: {
  rows: Array<{ key: string; currentValue: string; recommendedValue: string; description: MaybeLocalized; impact: MaybeLocalized; configHint?: ConfigHint }>
  locale: Locale
}) {
  const t = (key: TranslationKey) => translate(locale, key)
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
          {rows.map((r, idx) => (
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

export function K8sTuningSection({ locale, k8sTuning }: K8sTuningSectionProps) {
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate(locale, key, params)
  const { clusterVersion, kubeletConfig, kubeProxyConfig, containerdConfig, cniPlugin, controlPlaneFlags } = k8sTuning
  const { openItems, toggleItem } = useAuditOpen()

  function itemProps(value: string) {
    return {
      value,
      id: `audit-item-${value}`,
      open: openItems.has(value),
      onOpenChange: (v: boolean) => toggleItem(value, v),
    }
  }

  // Group control-plane flags by component
  const cpFlagsByComponent: Record<string, typeof controlPlaneFlags> = {}
  for (const f of controlPlaneFlags) {
    if (!cpFlagsByComponent[f.component]) cpFlagsByComponent[f.component] = []
    cpFlagsByComponent[f.component].push(f)
  }

  return (
    <Card className="border border-border shadow-sm bg-card rounded-2xl overflow-hidden">
      <CardHeader className="py-5 px-8 border-b bg-muted/50/30">
        <CardTitle className="text-[11px] font-black flex items-center gap-2 text-foreground uppercase tracking-widest">
          <Boxes className="h-4 w-4 text-blue-500" />
          {t("nodes.audit.k8sTuning")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pt-4 pb-4">
        <Accordion className="w-full space-y-3 px-4">

          {/* 12. Cluster Version */}
          <AccordionItem {...itemProps("cluster-version")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-blue-500 transition-colors`}>
                <Boxes className="h-4 w-4 text-blue-500" />
                {t("nodes.audit.clusterVersion")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
            </AccordionContent>
          </AccordionItem>

          {/* 13. CNI Plugin */}
          <AccordionItem {...itemProps("cni-plugin")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-cyan-500 transition-colors`}>
                <Network className="h-4 w-4 text-cyan-500" />
                {t("nodes.audit.cniPlugin")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
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
            </AccordionContent>
          </AccordionItem>

          {/* 14. Kubelet Config */}
          <AccordionItem {...itemProps("kubelet-config")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-purple-500 transition-colors`}>
                <Settings className="h-4 w-4 text-purple-500" />
                {t("nodes.audit.kubeletConfig")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <ConfigTable rows={kubeletConfig} locale={locale} />
            </AccordionContent>
          </AccordionItem>

          {/* 15. Kube-proxy Config — hidden when CNI replaces kube-proxy (e.g., Cilium kube-proxy-replacement) */}
          <AccordionItem {...itemProps("kubeproxy-config")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-amber-500 transition-colors`}>
                <Activity className="h-4 w-4 text-amber-500" />
                {t("nodes.audit.kubeProxyConfig")}
                {cniPlugin.kubeProxyReplacement && (
                  <Badge
                    variant="outline"
                    className="ml-2 text-[9px] font-bold uppercase tracking-wider text-narwhal-success border-narwhal-success/30 bg-narwhal-success/10"
                  >
                    {t("nodes.audit.replacedByCni")}
                  </Badge>
                )}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              {cniPlugin.kubeProxyReplacement ? (
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
                <ConfigTable rows={kubeProxyConfig} locale={locale} />
              )}
            </AccordionContent>
          </AccordionItem>

          {/* 16. Containerd Config */}
          <AccordionItem {...itemProps("containerd-config")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-teal-500 transition-colors`}>
                <Cpu className="h-4 w-4 text-teal-500" />
                {t("nodes.audit.containerdConfig")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0 border-t border-border bg-card">
              <ConfigTable rows={containerdConfig} locale={locale} />
            </AccordionContent>
          </AccordionItem>

          {/* 17. Control-plane Flags — master nodes only */}
          {controlPlaneFlags.length > 0 && (
            <AccordionItem {...itemProps("cp-flags")} className={ITEM_CLS}>
              <AccordionTrigger className={TRIGGER_CLS}>
                <span className={`${TRIGGER_LABEL} group-hover:text-rose-500 transition-colors`}>
                  <Settings className="h-4 w-4 text-rose-500" />
                  {t("nodes.audit.controlPlaneFlags")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="p-0 border-t border-border bg-card">
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
                                  {healthBadge(
                                    f.currentValue === f.recommendedValue,
                                    t("nodes.audit.badge.healthy"),
                                    t("nodes.audit.badge.tuneUp")
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          )}

        </Accordion>
      </CardContent>
    </Card>
  )
}
