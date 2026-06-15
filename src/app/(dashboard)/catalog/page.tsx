import { CatalogTable } from "@/components/catalog/catalog-table"
import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"

export default async function CatalogPage() {
  const locale = await getLocale()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "catalog.pageTitle")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "catalog.pageDesc")}</p>
      </div>
      <CatalogTable />
    </div>
  )
}
