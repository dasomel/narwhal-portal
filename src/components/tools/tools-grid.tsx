"use client"
import { useQuery } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { ServiceCard } from "./service-card"
import { PlatformTool } from "@/lib/tools"
import { useT } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"
import { DataState } from "@/components/ui/data-state"

export function ToolsGrid() {
  const { data: session } = useSession()
  const t = useT()

  const { data: tools, isLoading: isToolsLoading, isError: isToolsError, refetch } = useQuery<PlatformTool[]>({
    queryKey: ["tools"],
    queryFn: () => fetch("/api/tools").then((r) => r.json()),
  })

  const { data: health = {} } = useQuery<Record<string, string>>({
    queryKey: ["tools-health"],
    queryFn: () => fetch("/api/tools/health").then((r) => r.json()),
    refetchInterval: 60_000,
  })

  if (isToolsLoading) return <DataState state="loading" onRetry={() => { void refetch() }} />
  if (isToolsError) return <DataState state="error" onRetry={() => { void refetch() }} />

  const availableTools = tools ?? []
  const categories = [...new Set(availableTools.map((t) => t.category))]

  return (
    <div className="space-y-8">
      {categories.length === 0 ? (
        <DataState state="empty" />
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
                  {availableTools
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
