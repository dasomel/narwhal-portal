"use client"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n-client"
import { CATEGORY_ORDER, statusBadgeClass } from "./status-colors"
import type { PlatformStatus, StatusComponent } from "@/types/api"
import type { TranslationKey } from "@/lib/i18n"

type StatusCategory = StatusComponent["category"]

const categoryLabelKey: Record<StatusCategory, TranslationKey> = {
  "control-plane": "status.category.control-plane",
  gitops: "status.category.gitops",
  identity: "status.category.identity",
  registry: "status.category.registry",
  observability: "status.category.observability",
  storage: "status.category.storage",
  networking: "status.category.networking",
  database: "status.category.database",
}

const badgeKey: Record<StatusComponent["status"], TranslationKey> = {
  healthy: "status.badge.healthy",
  degraded: "status.badge.degraded",
  down: "status.badge.down",
  unknown: "status.badge.unknown",
}

function ComponentCard({ component, isOperator }: { component: StatusComponent; isOperator: boolean }) {
  const t = useT()
  const hasImpacts = component.status !== "healthy" && component.impacts.length > 0

  return (
    <Card className="p-4 gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm text-foreground truncate">{component.name}</span>
        {hasImpacts ? (
          <Tooltip>
            <TooltipTrigger>
              <Badge className={`text-xs cursor-default ${statusBadgeClass[component.status]}`}>
                {t(badgeKey[component.status])}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-medium mb-1">{t("status.impacts.title")}</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {component.impacts.map((impact) => (
                  <li key={impact}>{impact}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        ) : (
          <Badge className={`text-xs ${statusBadgeClass[component.status]}`}>
            {t(badgeKey[component.status])}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{component.detail}</p>
      {isOperator && (
        <p className="text-[11px] text-muted-foreground/70 font-mono truncate">
          {t("status.source.label")}: {component.source}
        </p>
      )}
    </Card>
  )
}

export function ComponentGrid({ status, isOperator }: { status: PlatformStatus; isOperator: boolean }) {
  const t = useT()

  const byCategory = new Map<StatusCategory, StatusComponent[]>()
  for (const component of status.components) {
    const list = byCategory.get(component.category) ?? []
    list.push(component)
    byCategory.set(component.category, list)
  }

  return (
    <div className="space-y-6">
      {CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => (
        <div key={category}>
          <h2 className="text-sm font-semibold text-foreground mb-2">{t(categoryLabelKey[category])}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {byCategory.get(category)!.map((component) => (
              <ComponentCard key={component.id} component={component} isOperator={isOperator} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
