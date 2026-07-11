import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FailureCounters } from "@/components/compliance/failure-counters"
import { ConfigAuditTable } from "@/components/compliance/config-audit-table"
import { RbacAuditTable } from "@/components/compliance/rbac-audit-table"
import { InfraAuditList } from "@/components/compliance/infra-audit-list"
import { FrameworksGrid } from "@/components/compliance/frameworks-grid"
import { KisaChecklist } from "@/components/compliance/kisa-checklist"
import type { ComplianceSummary } from "@/types/compliance"

async function fetchComplianceSummary(): Promise<ComplianceSummary | null> {
  try {
    const { getComplianceSummary } = await import("@/lib/compliance")
    return await getComplianceSummary()
  } catch {
    return null
  }
}

const emptySummary: ComplianceSummary = {
  totalConfigAuditFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  lowSeverityConfigAuditFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  acceptedSystemConfigAuditFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  totalRbacFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  acceptedRbacFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  totalInfraFailures: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  frameworks: [],
  scannedWorkloads: 0,
  scannedRbacObjects: 0,
  scannedNodes: 0,
  lastUpdated: new Date().toISOString(),
}

export default async function CompliancePage() {
  const session = await auth()
  if (!session) redirect("/login")

  if (session.user?.role !== "cluster-admin") {
    const locale = await getLocale()
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="rounded-lg border bg-card p-8 max-w-md w-full text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold text-foreground">{t(locale, "compliance.forbidden")}</h2>
          <p className="text-sm text-muted-foreground">{t(locale, "compliance.subtitle")}</p>
        </div>
      </div>
    )
  }

  const locale = await getLocale()
  const summary = await fetchComplianceSummary()
  const effectiveSummary = summary ?? emptySummary

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "compliance.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "compliance.subtitle")}</p>
      </div>

      {/* Failure counter cards */}
      <FailureCounters summary={effectiveSummary} locale={locale} />

      {/* Tabs */}
      <Tabs defaultValue="config-audit">
        <TabsList>
          <TabsTrigger value="config-audit">{t(locale, "compliance.tab.configAudit")}</TabsTrigger>
          <TabsTrigger value="rbac">{t(locale, "compliance.tab.rbac")}</TabsTrigger>
          <TabsTrigger value="infra">{t(locale, "compliance.tab.infra")}</TabsTrigger>
          <TabsTrigger value="frameworks">{t(locale, "compliance.tab.frameworks")}</TabsTrigger>
          <TabsTrigger value="kisa">{t(locale, "compliance.tab.kisa")}</TabsTrigger>
        </TabsList>
        <TabsContent value="config-audit" className="mt-4">
          <ConfigAuditTable />
        </TabsContent>
        <TabsContent value="rbac" className="mt-4">
          <RbacAuditTable />
        </TabsContent>
        <TabsContent value="infra" className="mt-4">
          <InfraAuditList />
        </TabsContent>
        <TabsContent value="frameworks" className="mt-4">
          <FrameworksGrid />
        </TabsContent>
        <TabsContent value="kisa" className="mt-4">
          <KisaChecklist />
        </TabsContent>
      </Tabs>
    </div>
  )
}
