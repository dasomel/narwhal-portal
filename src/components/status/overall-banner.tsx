"use client"

import { Card } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n-client"
import { statusPillClass } from "./status-colors"
import type { PlatformStatus } from "@/types/api"
import type { TranslationKey } from "@/lib/i18n"

const headlineKey: Record<PlatformStatus["overall"], TranslationKey> = {
  healthy: "status.headline.healthy",
  degraded: "status.headline.degraded",
  down: "status.headline.down",
  unknown: "status.headline.unknown",
}

const badgeKey: Record<PlatformStatus["overall"], TranslationKey> = {
  healthy: "status.badge.healthy",
  degraded: "status.badge.degraded",
  down: "status.badge.down",
  unknown: "status.badge.unknown",
}

export function OverallBanner({ status }: { status: PlatformStatus }) {
  const t = useT()

  const nonHealthy = status.components.filter((c) => c.status !== "healthy")
  const names = nonHealthy.map((c) => c.name).join(", ")
  const headline =
    status.overall === "healthy"
      ? t(headlineKey.healthy)
      : t(headlineKey[status.overall], { count: nonHealthy.length, names })

  return (
    <Card className="p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <Tooltip>
          <TooltipTrigger className="flex items-center gap-3 text-left cursor-default">
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${statusPillClass[status.overall]}`}
            >
              {t(badgeKey[status.overall])}
            </span>
            <span className="text-lg font-semibold text-foreground">{headline}</span>
          </TooltipTrigger>
          <TooltipContent>{status.summary}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
          <span>
            {t("status.nodes.label", { ready: status.nodes.ready, total: status.nodes.total })}
          </span>
          <span className="hidden sm:inline">
            {t("status.generatedAt", { time: new Date(status.generatedAt).toLocaleTimeString() })}
          </span>
        </div>
      </div>
    </Card>
  )
}
