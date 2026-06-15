"use client"
import { Card } from "@/components/ui/card"
import type { PlatformTool } from "@/lib/tools"
import { useT } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"

type HealthStatus = "healthy" | "degraded" | "offline" | "loading"

interface ServiceCardProps {
  tool: PlatformTool
  health: HealthStatus
}

const healthConfig: Record<HealthStatus, { badge: string; dot: string }> = {
  healthy: { badge: "bg-narwhal-success/15 text-narwhal-success", dot: "bg-narwhal-success" },
  degraded: { badge: "bg-narwhal-warning/15 text-narwhal-warning", dot: "bg-narwhal-warning" },
  offline: { badge: "bg-narwhal-danger/15 text-narwhal-danger", dot: "bg-narwhal-danger" },
  loading: { badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/30 animate-pulse" },
}

const healthLabelKey: Record<HealthStatus, TranslationKey> = {
  healthy: "health.healthy",
  degraded: "health.degraded",
  offline: "health.offline",
  loading: "health.loading",
}

export function ServiceCard({ tool, health }: ServiceCardProps) {
  const t = useT()
  const cfg = healthConfig[health]
  const descriptionKey = `tool.${tool.id}` as TranslationKey

  return (
    <a href={tool.url} target="_blank" rel="noopener noreferrer">
      <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer group h-full">
        <div className="flex items-start justify-between mb-3">
          <img src={tool.icon} alt={tool.name} width={40} height={40} className="rounded-lg" />
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1.5 ${cfg.badge}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {t(healthLabelKey[health])}
          </span>
        </div>
        <h3 className="font-semibold text-foreground group-hover:text-narwhal-accent transition-colors">
          {tool.name}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">{t(descriptionKey)}</p>
      </Card>
    </a>
  )
}
