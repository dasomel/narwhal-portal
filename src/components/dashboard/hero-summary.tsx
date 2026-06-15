"use client"

import { Narwhal } from "@/components/narwhal/narwhal"
import { useT } from "@/lib/i18n-client"
import type { HeroResponse } from "@/types/api"

interface HeroSummaryProps {
  data: HeroResponse
}

export function HeroSummary({ data }: HeroSummaryProps) {
  const t = useT()
  const { summary, mascot, copy } = data

  const cpuColor = summary.cpu > 90 ? "text-danger" : summary.cpu > 75 ? "text-warning" : "text-text-secondary"
  const memColor = summary.memory > 90 ? "text-danger" : summary.memory > 75 ? "text-warning" : "text-text-secondary"

  const stateColor =
    mascot === "healthy"
      ? "bg-success/15 text-success"
      : mascot === "warning"
        ? "bg-warning/15 text-warning"
        : "bg-danger/15 text-danger"

  const stateLabel = mascot === "healthy" ? "● healthy" : mascot === "warning" ? "● warning" : "● critical"

  return (
    <div className="flex items-center gap-4">
      <div className="flex-shrink-0">
        <Narwhal state={mascot} size={120} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[17px] font-semibold text-text-primary leading-tight">{copy.title}</div>
        <div className="text-[13px] text-text-secondary mt-1">{copy.subtitle}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${stateColor}`}>{stateLabel}</span>
          <span className={`text-xs px-3 py-1 rounded-full bg-surface/70 ${cpuColor}`}>
            CPU {summary.cpu}%
          </span>
          <span className={`text-xs px-3 py-1 rounded-full bg-surface/70 ${memColor}`}>
            MEM {summary.memory}%
          </span>
          <span className="text-xs px-3 py-1 rounded-full bg-surface/70 text-text-secondary">
            Nodes {summary.nodes?.ready ?? "-"}/{summary.nodes?.total ?? "-"}
          </span>
          <span className="text-xs px-3 py-1 rounded-full bg-surface/70 text-text-secondary">
            Pods {summary.pods?.running ?? "-"}
          </span>
        </div>
      </div>
    </div>
  )
}
