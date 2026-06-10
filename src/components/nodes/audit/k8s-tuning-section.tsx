"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Boxes, Settings, Activity, Network, Cpu } from "lucide-react"
import { t as translate } from "@/lib/i18n"
import type { TranslationKey, Locale } from "@/lib/i18n"
import { useAuditOpen } from "./audit-open-context"
import {
  AuditItemDetail,
  TRIGGER_CLS,
  ITEM_CLS,
  TRIGGER_LABEL,
  type SystemStatusInput,
} from "./audit-item-detail"
import { computeActionItems } from "./system-check-summary"

interface K8sTuningSectionProps {
  locale: Locale
  systemStatus: SystemStatusInput
  nodeName?: string
  userRole?: string
}

// K8s items that are tracked by computeActionItems (filterable)
const K8S_ITEMS_FILTERABLE = ["cluster-version", "kubelet-config", "kubeproxy-config", "containerd-config"]

export function K8sTuningSection({ locale, systemStatus, nodeName, userRole }: K8sTuningSectionProps) {
  const t = (key: TranslationKey) => translate(locale, key)
  const { cniPlugin, controlPlaneFlags } = systemStatus.k8sTuning
  const { openItems, toggleItem } = useAuditOpen()
  const [showAll, setShowAll] = useState(false)

  const actionIds = computeActionItems(systemStatus)

  function itemProps(value: string) {
    return {
      value,
      id: `audit-item-${value}`,
      open: openItems.has(value),
      onOpenChange: (v: boolean) => toggleItem(value, v),
    }
  }

  function isVisible(id: string): boolean {
    if (showAll) return true
    // items not tracked by computeActionItems are always shown
    if (!K8S_ITEMS_FILTERABLE.includes(id)) return true
    return actionIds.has(id)
  }

  const detailProps = { systemStatus, locale, nodeName, userRole, showAll }

  // Count how many filterable items are hidden (action only mode, none triggered)
  const filterableActionCount = K8S_ITEMS_FILTERABLE.filter(id => actionIds.has(id)).length
  const allFilterablePassed = !showAll && filterableActionCount === 0

  return (
    <Card className="border border-border shadow-sm bg-card rounded-2xl overflow-hidden">
      <CardHeader className="py-5 px-8 border-b bg-muted/50/30">
        <CardTitle className="text-xs font-black flex items-center gap-2 text-foreground uppercase tracking-widest">
          <Boxes className="h-4 w-4 text-blue-500" />
          {t("nodes.audit.k8sTuning")}
          <button
            type="button"
            onClick={() => setShowAll(v => !v)}
            className="ml-auto text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAll ? t("nodes.audit.actionOnly") : t("nodes.audit.showAll")}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pt-4 pb-4">
        {allFilterablePassed && (
          <p className="px-8 py-2 text-xs font-black uppercase tracking-widest text-narwhal-success">
            {t("nodes.audit.allPassed")}
          </p>
        )}
        <Accordion className="w-full space-y-3 px-4">

          {/* Cluster Version */}
          {isVisible("cluster-version") && (
            <AccordionItem {...itemProps("cluster-version")} className={ITEM_CLS}>
              <AccordionTrigger className={TRIGGER_CLS}>
                <span className={`${TRIGGER_LABEL} group-hover:text-blue-500 transition-colors`}>
                  <Boxes className="h-4 w-4 text-blue-500" />
                  {t("nodes.audit.clusterVersion")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="border-t border-border bg-card">
                <AuditItemDetail id="cluster-version" {...detailProps} />
              </AccordionContent>
            </AccordionItem>
          )}

          {/* CNI Plugin — always shown (not tracked by computeActionItems) */}
          <AccordionItem {...itemProps("cni-plugin")} className={ITEM_CLS}>
            <AccordionTrigger className={TRIGGER_CLS}>
              <span className={`${TRIGGER_LABEL} group-hover:text-cyan-500 transition-colors`}>
                <Network className="h-4 w-4 text-cyan-500" />
                {t("nodes.audit.cniPlugin")}
              </span>
            </AccordionTrigger>
            <AccordionContent className="border-t border-border bg-card">
              <AuditItemDetail id="cni-plugin" {...detailProps} />
            </AccordionContent>
          </AccordionItem>

          {/* Kubelet Config */}
          {isVisible("kubelet-config") && (
            <AccordionItem {...itemProps("kubelet-config")} className={ITEM_CLS}>
              <AccordionTrigger className={TRIGGER_CLS}>
                <span className={`${TRIGGER_LABEL} group-hover:text-purple-500 transition-colors`}>
                  <Settings className="h-4 w-4 text-purple-500" />
                  {t("nodes.audit.kubeletConfig")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="border-t border-border bg-card">
                <AuditItemDetail id="kubelet-config" {...detailProps} />
              </AccordionContent>
            </AccordionItem>
          )}

          {/* Kube-proxy Config */}
          {isVisible("kubeproxy-config") && (
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
              <AccordionContent className="border-t border-border bg-card">
                <AuditItemDetail id="kubeproxy-config" {...detailProps} />
              </AccordionContent>
            </AccordionItem>
          )}

          {/* Containerd Config */}
          {isVisible("containerd-config") && (
            <AccordionItem {...itemProps("containerd-config")} className={ITEM_CLS}>
              <AccordionTrigger className={TRIGGER_CLS}>
                <span className={`${TRIGGER_LABEL} group-hover:text-teal-500 transition-colors`}>
                  <Cpu className="h-4 w-4 text-teal-500" />
                  {t("nodes.audit.containerdConfig")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="border-t border-border bg-card">
                <AuditItemDetail id="containerd-config" {...detailProps} />
              </AccordionContent>
            </AccordionItem>
          )}

          {/* Control-plane Flags — master nodes only, always shown */}
          {controlPlaneFlags.length > 0 && (
            <AccordionItem {...itemProps("cp-flags")} className={ITEM_CLS}>
              <AccordionTrigger className={TRIGGER_CLS}>
                <span className={`${TRIGGER_LABEL} group-hover:text-rose-500 transition-colors`}>
                  <Settings className="h-4 w-4 text-rose-500" />
                  {t("nodes.audit.controlPlaneFlags")}
                </span>
              </AccordionTrigger>
              <AccordionContent className="border-t border-border bg-card">
                <AuditItemDetail id="cp-flags" {...detailProps} />
              </AccordionContent>
            </AccordionItem>
          )}

        </Accordion>
      </CardContent>
    </Card>
  )
}
