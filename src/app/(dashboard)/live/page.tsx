import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { Narwhal } from "@/components/narwhal/narwhal"
import { LiveStreamWrapper } from "@/components/live/live-stream-wrapper"
import type { FilterKey } from "@/components/live/filter-chips"

interface LivePageProps {
  searchParams: Promise<{ filter?: string }>
}

function resolveFilter(raw: string | undefined): FilterKey {
  if (raw === "incidents") return "critical"
  const valid: FilterKey[] = ["all", "alerts", "deploys", "syncs", "critical"]
  if (valid.includes(raw as FilterKey)) return raw as FilterKey
  return "all"
}

export default async function LivePage({ searchParams }: LivePageProps) {
  const locale = await getLocale()
  const params = await searchParams
  const initialFilter = resolveFilter(params.filter)

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Narwhal state="healthy" size={32} />
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t(locale, "live.title")}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{t(locale, "live.description")}</p>
        </div>
      </div>

      {/* Stream + connection indicator (single EventSource) */}
      <LiveStreamWrapper initialFilter={initialFilter} />
    </div>
  )
}
