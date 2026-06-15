import { ClusterMetrics } from "@/components/dashboard/cluster-metrics"
import { ArgoCDStatus } from "@/components/dashboard/argocd-status"
import { AlertsWidget } from "@/components/dashboard/alerts-widget"
import { NodeMetrics } from "@/components/dashboard/node-metrics"
import { MetricChartsSection } from "@/components/dashboard/metric-charts-section"
import { EventTimeline } from "@/components/dashboard/event-timeline"
import { HeroZone } from "@/components/dashboard/hero-zone"
import { InfrastructurePanel } from "@/components/dashboard/infrastructure-panel"
import { ApplicationsPanel } from "@/components/dashboard/applications-panel"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"

const NEW_DASHBOARD = process.env.NEXT_PUBLIC_NEW_DASHBOARD === "true"

export default async function HomePage() {
  const locale = await getLocale()

  if (NEW_DASHBOARD) {
    return (
      <div className="space-y-6">
        <HeroZone />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <InfrastructurePanel />
          <ApplicationsPanel />
        </div>
        <ActivityFeed />
      </div>
    )
  }

  // Legacy layout — preserved until Phase A is validated
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "dashboard.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "dashboard.description")}</p>
      </div>
      <ClusterMetrics />
      <MetricChartsSection />
      <NodeMetrics />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ArgoCDStatus />
        <AlertsWidget />
      </div>
      <EventTimeline />
    </div>
  )
}
