"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  Network, ShieldAlert, Cpu, HardDrive, Wifi, Package, Layers, Activity, Server, Database,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
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

interface NodeTuningSectionProps {
  locale: Locale
  nodeName?: string
  userRole?: string
  systemStatus: SystemStatusInput
}

// id → label/icon/hover-color. Order matches the previous accordion layout.
const NODE_ITEMS: Array<{ id: string; icon: LucideIcon; color: string; hover: string; labelKey: TranslationKey }> = [
  { id: "kernel-params",     icon: Network,     color: "text-blue-500",    hover: "group-hover:text-blue-500",    labelKey: "nodes.audit.kernel" },
  { id: "kernel-modules",    icon: Layers,      color: "text-purple-500",  hover: "group-hover:text-purple-500",  labelKey: "nodes.audit.kernelModules" },
  { id: "resource-limits",   icon: Cpu,         color: "text-amber-500",   hover: "group-hover:text-amber-500",   labelKey: "nodes.audit.resourceLimits" },
  { id: "required-packages", icon: Package,     color: "text-green-600",   hover: "group-hover:text-green-600",   labelKey: "nodes.audit.requiredPackages" },
  { id: "disk-tuning",       icon: HardDrive,   color: "text-orange-500",  hover: "group-hover:text-orange-500",  labelKey: "nodes.audit.diskTuning" },
  { id: "lvm-auto-extend",   icon: Database,    color: "text-yellow-600",  hover: "group-hover:text-yellow-600",  labelKey: "nodes.audit.lvmAutoExtend" },
  { id: "nic-tuning",        icon: Wifi,        color: "text-cyan-500",    hover: "group-hover:text-cyan-500",    labelKey: "nodes.audit.nicTuning" },
  { id: "runtime-status",    icon: Activity,    color: "text-emerald-500", hover: "group-hover:text-emerald-500", labelKey: "nodes.audit.runtimeStatus" },
  { id: "cgroup",            icon: Layers,      color: "text-indigo-500",  hover: "group-hover:text-indigo-500",  labelKey: "nodes.audit.cgroup" },
  { id: "swap",              icon: Database,    color: "text-rose-500",    hover: "group-hover:text-rose-500",    labelKey: "nodes.audit.swap" },
  { id: "security",          icon: ShieldAlert, color: "text-rose-600",    hover: "group-hover:text-rose-600",    labelKey: "nodes.audit.security" },
]

export function NodeTuningSection({ locale, nodeName, userRole, systemStatus }: NodeTuningSectionProps) {
  const t = (key: TranslationKey) => translate(locale, key)
  const { openItems, toggleItem } = useAuditOpen()
  const [showAll, setShowAll] = useState(false)

  const actionIds = computeActionItems(systemStatus)
  const visibleItems = showAll ? NODE_ITEMS : NODE_ITEMS.filter(it => actionIds.has(it.id))

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
        <CardTitle className="text-xs font-black flex items-center gap-2 text-foreground uppercase tracking-widest">
          <Server className="h-4 w-4 text-narwhal-accent" />
          {t("nodes.audit.nodeTuning")}
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
        {visibleItems.length === 0 ? (
          <p className="px-8 py-4 text-xs font-black uppercase tracking-widest text-narwhal-success">
            {t("nodes.audit.allPassed")}
          </p>
        ) : (
          <Accordion className="w-full space-y-3 px-4">
            {visibleItems.map(({ id, icon: Icon, color, hover, labelKey }) => (
              <AccordionItem key={id} {...itemProps(id)} className={ITEM_CLS}>
                <AccordionTrigger className={TRIGGER_CLS}>
                  <span className={`${TRIGGER_LABEL} ${hover} transition-colors`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                    {t(labelKey)}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="border-t border-border bg-card">
                  <AuditItemDetail id={id} systemStatus={systemStatus} locale={locale} nodeName={nodeName} userRole={userRole} showAll={showAll} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  )
}
