import { RouteLoadingFallback } from "@/components/ui/route-loading-fallback"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"

// Segment-level loading UI for the whole (dashboard) route group (issue #62).
export default async function DashboardLoading() {
  const locale = await getLocale()
  return <RouteLoadingFallback label={t(locale, "routeState.loading")} />
}
