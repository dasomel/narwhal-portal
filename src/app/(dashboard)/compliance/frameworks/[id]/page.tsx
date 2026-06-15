import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { translateTitle } from "@/lib/check-translations"
import { Badge } from "@/components/ui/badge"
import type { ComplianceFrameworkDetail, Severity } from "@/types/compliance"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

const severityOrder: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]

interface Props {
  params: Promise<{ id: string }>
}

async function fetchDetail(id: string): Promise<ComplianceFrameworkDetail | null> {
  try {
    const { getComplianceFrameworkDetail } = await import("@/lib/compliance")
    return await getComplianceFrameworkDetail(id)
  } catch {
    return null
  }
}

export default async function FrameworkDetailPage({ params }: Props) {
  const session = await auth()
  if (!session) redirect("/login")

  const locale = await getLocale()

  if (session.user?.role !== "cluster-admin") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="rounded-lg border bg-card p-8 max-w-md w-full text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold">{t(locale, "compliance.forbidden")}</h2>
        </div>
      </div>
    )
  }

  const { id } = await params
  const idDecoded = decodeURIComponent(id)

  const detail = await fetchDetail(idDecoded)

  if (!detail) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href="/compliance">← {t(locale, "common.back")}</a>
          <h1 className="text-xl font-bold">{t(locale, "compliance.detail.title")}</h1>
        </div>
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          {t(locale, "common.notFound")}
        </div>
      </div>
    )
  }

  const sorted = [...detail.controls].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  )

  const passRatePct = Math.round(detail.passRate * (detail.passRate <= 1 ? 100 : 1))
  const barColor =
    passRatePct >= 80 ? "bg-green-500" : passRatePct >= 50 ? "bg-amber-500" : "bg-red-500"

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href="/compliance">← {t(locale, "common.back")}</a>
        <div>
          <h1 className="text-xl font-bold text-foreground">{detail.title}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(locale, "compliance.framework.passRate")}: {passRatePct}% &middot;{" "}
            {t(locale, "compliance.framework.controls", { count: detail.totalControls })}
          </p>
        </div>
      </div>

      {/* Pass rate bar + counters */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t(locale, "compliance.framework.passRate")}</span>
          <span
            className={`font-bold text-lg ${
              passRatePct >= 80
                ? "text-green-600"
                : passRatePct >= 50
                ? "text-amber-600"
                : "text-red-600"
            }`}
          >
            {passRatePct}%
          </span>
        </div>
        <div className="w-full bg-muted rounded-full h-2.5">
          <div className={`h-2.5 rounded-full ${barColor}`} style={{ width: `${passRatePct}%` }} />
        </div>
        <div className="flex gap-4 text-sm">
          <span className="text-green-600 font-medium">✓ {detail.passCount} {t(locale, "compliance.check.passed")}</span>
          <span className="text-red-600 font-medium">✗ {detail.failCount} {t(locale, "compliance.check.failed")}</span>
        </div>
      </div>

      {/* Controls table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/30">
          <h2 className="text-sm font-semibold">
            {t(locale, "compliance.framework.controls", { count: sorted.length })}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted/20">
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "compliance.check.passed")}</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "compliance.check.failed")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((ctrl) => (
                <tr key={ctrl.id} className="border-b last:border-0 hover:bg-muted/10">
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {ctrl.id}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{idDecoded.startsWith("k8s-cis") ? translateTitle("cis", ctrl.id, ctrl.name, locale) : ctrl.name}</p>
                    {ctrl.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{ctrl.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge className={`text-xs ${severityBadgeClass[ctrl.severity] ?? severityBadgeClass.Unknown}`}>
                      {ctrl.severity}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-green-600 font-medium">{ctrl.passCount}</td>
                  <td className="px-4 py-2.5 text-red-600 font-medium">{ctrl.failCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
