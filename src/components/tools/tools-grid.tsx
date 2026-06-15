"use client"
import { useQuery } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { ServiceCard } from "./service-card"
import { PlatformTool } from "@/lib/tools"
import { useT } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"

export function ToolsGrid() {
  const { data: session } = useSession()
  const t = useT()

  const { data: tools = [], isLoading: isToolsLoading } = useQuery<PlatformTool[]>({
    queryKey: ["tools"],
    queryFn: () => fetch("/api/tools").then((r) => r.json()),
  })

  const { data: health = {} } = useQuery<Record<string, string>>({
    queryKey: ["tools-health"],
    queryFn: () => fetch("/api/tools/health").then((r) => r.json()),
    refetchInterval: 60_000,
  })

  if (isToolsLoading) {
    return (
      <div className="h-64 flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <div className="w-8 h-8 border-2 border-border border-t-narwhal-danger rounded-full animate-spin" />
        <span className="text-sm">{t("common.loading")}</span>
      </div>
    )
  }

  const categories = [...new Set(tools.map((t) => t.category))]

  return (
    <div className="space-y-8">
      {categories.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed rounded-xl border-border/50 italic text-muted-foreground">
          No tools mapped to your current roles/groups.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-narwhal-success inline-block" />
              {t("health.healthy")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-narwhal-warning inline-block" />
              {t("health.degraded")}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-narwhal-danger inline-block" />
              {t("health.offline")}
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {categories.map((cat) => (
              <div key={cat} className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {t(`category.${cat}` as TranslationKey)}
                </h2>
                <div className="grid grid-cols-3 gap-3">
                  {tools
                    .filter((t) => t.category === cat)
                    .map((tool) => (
                      <ServiceCard
                        key={tool.id}
                        tool={tool}
                        health={(health[tool.id] as "healthy" | "degraded" | "offline") ?? "loading"}
                      />
                    ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
