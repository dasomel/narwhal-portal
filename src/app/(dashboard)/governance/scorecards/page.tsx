// TODO(wrap-up): i18n keys for ko/en — see spec §5.7
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { ScorecardsTable } from "@/components/governance/scorecards-table"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"

export default async function ScorecardsPage() {
  const session = await auth()
  if (!session) redirect("/login")

  const role = session.user.role
  if (role === "guest") redirect("/onboarding")

  const locale = await getLocale()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "scorecard.pageTitle")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t(locale, "scorecard.pageDesc")}
        </p>
      </div>
      <ScorecardsTable />
    </div>
  )
}
