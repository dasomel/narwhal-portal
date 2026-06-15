import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"
import { ArchitectureView } from "@/components/architecture/architecture-view"

export default async function ArchitecturePage() {
  const locale = await getLocale()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "architecture.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "architecture.description")}</p>
      </div>
      <ArchitectureView />
    </div>
  )
}
