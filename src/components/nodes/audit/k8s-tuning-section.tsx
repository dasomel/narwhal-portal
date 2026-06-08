"use client"

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

interface K8sTuningSectionProps {
  locale: Locale
  systemStatus: SystemStatusInput
  nodeName?: string
  userRole?: string
}

export function K8sTuningSection({ locale, systemStatus, nodeName, userRole }: K8sTuningSectionProps) {
  const t = (key: TranslationKey) => translate(locale, key)
  const { cniPlugin, controlPlaneFlags } = systemStatus.k8sTuning
  const { openItems, toggleItem } = useAuditOpen()

  function itemProps(value: string) {
    return {
      value,
      id: `audit-item-${value}`,
      open: openItems.has(value),
      onOpenChange: (v: boolean) => toggleItem(value, v),
    }
  }

  const detailProps = { systemStatus, locale, nodeName, userRole }

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

          {/* Cluster Version */}
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

          {/* CNI Plugin */}
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

          {/* Kube-proxy Config — hidden behavior when CNI replaces kube-proxy */}
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

          {/* Containerd Config */}
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

          {/* Control-plane Flags — master nodes only */}
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
