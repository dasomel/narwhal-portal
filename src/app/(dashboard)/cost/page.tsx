import { CostOverview } from "@/components/cost/cost-overview"
import { CostBreakdownTable } from "@/components/cost/cost-breakdown-table"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"

export default async function CostPage() {
  const locale = await getLocale()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "cost.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(locale, "cost.description")}
        </p>
      </div>

      <CostOverview />
      <CostBreakdownTable />
    </div>
  )
}
