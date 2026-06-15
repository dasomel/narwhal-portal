// @deprecated — see docs/superpowers/specs/2026-04-17-dashboard-narwhal-redesign-design.md §5.3
// Absorbed into HeroSummary chip row. Delete after Phase A validation.
"use client"
import { useQuery } from "@tanstack/react-query"
import { MetricCard } from "./metric-card"
import { useT } from "@/lib/i18n-client"

interface ClusterMetrics {
  cpu: number | null
  memory: number | null
  nodes: { total: number | null; ready: number | null }
  pods: { total: number | null; running: number | null }
}

export function ClusterMetrics() {
  const t = useT()
  const { data, isLoading, isError } = useQuery<ClusterMetrics>({
    queryKey: ["metrics"],
    queryFn: () => fetch("/api/metrics").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[t("metrics.cpu"), t("metrics.memory"), t("metrics.nodes"), t("metrics.pods")].map((title) => (
          <MetricCard key={title} title={title} value={null} color="default" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[t("metrics.cpu"), t("metrics.memory"), t("metrics.nodes"), t("metrics.pods")].map((title) => (
          <MetricCard key={title} title={title} value={t("common.loadError")} color="default" />
        ))}
      </div>
    )
  }

  const cpuColor = !data?.cpu ? "default" : data.cpu > 80 ? "red" : data.cpu > 60 ? "yellow" : "green"
  const memColor = !data?.memory ? "default" : data.memory > 80 ? "red" : data.memory > 60 ? "yellow" : "green"

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <MetricCard
        title={t("metrics.cpu")}
        value={data?.cpu !== null && data?.cpu !== undefined ? `${data.cpu}%` : null}
        color={cpuColor}
      />
      <MetricCard
        title={t("metrics.memory")}
        value={data?.memory !== null && data?.memory !== undefined ? `${data.memory}%` : null}
        color={memColor}
      />
      <MetricCard
        title={t("metrics.nodes")}
        value={data?.nodes?.ready !== null && data?.nodes?.ready !== undefined ? `${data.nodes.ready}/${data.nodes?.total}` : null}
        subtitle="Ready"
        color="green"
      />
      <MetricCard
        title={t("metrics.pods")}
        value={data?.pods?.running !== null && data?.pods?.running !== undefined ? `${data.pods.running}/${data.pods?.total}` : null}
        subtitle="Running"
        color="green"
      />
    </div>
  )
}
