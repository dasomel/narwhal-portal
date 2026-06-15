import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { TemplateList } from "@/components/templates/template-list"

export default async function TemplatesPage() {
  const locale = await getLocale()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "templates.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "templates.description")}</p>
      </div>
      <TemplateList />
    </div>
  )
}
