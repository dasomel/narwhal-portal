import { RouteLoadingFallback } from "@/components/ui/route-loading-fallback"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"

export default async function SettingsLoading() {
  const locale = await getLocale()
  return <RouteLoadingFallback label={t(locale, "routeState.loading")} />
}
