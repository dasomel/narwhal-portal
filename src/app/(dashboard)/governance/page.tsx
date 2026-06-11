import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScorecardTable } from "@/components/governance/scorecard-table"
import { RbacTable } from "@/components/governance/rbac-table"
import { ResourceChart } from "@/components/governance/resource-chart"
import { DistributionView } from "@/components/governance/distribution-view"
import { AuditTable } from "@/components/governance/audit-table"
import { DoraMetricsWidget } from "@/components/governance/dora-metrics"
import { TracesTable } from "@/components/governance/traces-table"

export default async function GovernancePage() {
  const locale = await getLocale()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "governance.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "governance.description")}</p>
      </div>

      <Tabs defaultValue="scorecard">
        <TabsList>
          <TabsTrigger value="scorecard">{t(locale, "governance.tabScorecard")}</TabsTrigger>
          <TabsTrigger value="rbac">{t(locale, "governance.tabRbac")}</TabsTrigger>
          <TabsTrigger value="resources">{t(locale, "governance.tabResources")}</TabsTrigger>
          <TabsTrigger value="distribution">{t(locale, "governance.tabDistribution")}</TabsTrigger>
          <TabsTrigger value="audit">{t(locale, "governance.tabAudit")}</TabsTrigger>
          <TabsTrigger value="dora">{t(locale, "governance.tabDora")}</TabsTrigger>
          <TabsTrigger value="traces">{t(locale, "governance.tabTraces")}</TabsTrigger>
        </TabsList>
        <TabsContent value="scorecard" className="mt-4">
          <ScorecardTable />
        </TabsContent>
        <TabsContent value="rbac" className="mt-4">
          <RbacTable />
        </TabsContent>
        <TabsContent value="resources" className="mt-4">
          <ResourceChart />
        </TabsContent>
        <TabsContent value="distribution" className="mt-4">
          <DistributionView />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTable />
        </TabsContent>
        <TabsContent value="dora" className="mt-4">
          <DoraMetricsWidget />
        </TabsContent>
        <TabsContent value="traces" className="mt-4">
          <TracesTable />
        </TabsContent>
      </Tabs>
    </div>
  )
}
