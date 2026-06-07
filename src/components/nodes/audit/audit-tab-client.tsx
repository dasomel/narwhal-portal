"use client"

import { AuditOpenProvider } from "./audit-open-context"
import { SystemCheckSummary } from "./system-check-summary"
import { NodeTuningSection } from "./node-tuning-section"
import { K8sTuningSection } from "./k8s-tuning-section"
import { ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Locale } from "@/lib/i18n"
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
  nodeName: string
  userRole?: string
  scanInsightLabel: string
  auditTitleLabel: string
}

export function AuditTabClient({
  systemStatus,
  locale,
  nodeName,
  userRole,
  scanInsightLabel,
  auditTitleLabel,
}: Props) {
  return (
    <AuditOpenProvider>
      <div className="space-y-4">
        <SystemCheckSummary systemStatus={systemStatus} locale={locale} />
        <div className="flex items-center justify-between px-1">
          <h2 className="text-[11px] font-bold flex items-center gap-2 text-foreground uppercase tracking-widest font-mono">
            <ShieldAlert className="h-4 w-4 text-rose-500" /> {auditTitleLabel}
          </h2>
          <Badge variant="outline" className="bg-muted/50/50 font-bold text-muted-foreground border-border uppercase text-[9px] tracking-[0.2em] px-3 py-1">
            {scanInsightLabel}
          </Badge>
        </div>
        <NodeTuningSection
          locale={locale}
          nodeName={nodeName}
          userRole={userRole}
          kernelParams={systemStatus.kernelParams}
          kernelModules={systemStatus.kernelModules}
          resourceLimits={systemStatus.resourceLimits}
          requiredPackages={systemStatus.requiredPackages}
          diskTuning={systemStatus.diskTuning}
          lvmAutoExtend={systemStatus.lvmAutoExtend}
          nicTuning={systemStatus.nicTuning}
          runtimeStatus={systemStatus.runtimeStatus}
          cgroup={systemStatus.cgroup}
          swap={systemStatus.swap}
          packageUpdates={systemStatus.packageUpdates}
        />
        <K8sTuningSection locale={locale} k8sTuning={systemStatus.k8sTuning} />
      </div>
    </AuditOpenProvider>
  )
}
