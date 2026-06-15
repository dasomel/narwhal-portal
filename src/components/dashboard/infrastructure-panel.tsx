import { MetricChartsSection } from "./metric-charts-section"
import { NodeMetrics } from "./node-metrics"

export function InfrastructurePanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-widest text-text-muted uppercase">
          ⎔ Infrastructure
        </span>
      </div>
      <MetricChartsSection />
      <NodeMetrics />
    </div>
  )
}
