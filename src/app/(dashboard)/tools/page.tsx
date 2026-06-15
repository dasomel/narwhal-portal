import { ToolsGrid } from "@/components/tools/tools-grid"
import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"

export default async function ToolsPage() {
  const locale = await getLocale()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "tools.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "tools.description")}</p>
      </div>
      <ToolsGrid />
    </div>
  )
}
