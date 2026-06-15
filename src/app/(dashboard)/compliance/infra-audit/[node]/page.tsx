import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { translateTitle, translateRemediation } from "@/lib/check-translations"
import { Badge } from "@/components/ui/badge"
import type { InfraAuditDetail, Severity } from "@/types/compliance"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

const severityOrder: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]

interface Props {
  params: Promise<{ node: string }>
}

async function fetchDetail(node: string): Promise<InfraAuditDetail | null> {
  try {
    const { getInfraAuditDetail } = await import("@/lib/compliance")
    return await getInfraAuditDetail(node)
  } catch {
    return null
  }
}

export default async function InfraAuditDetailPage({ params }: Props) {
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

  const { node } = await params
  const nodeDecoded = decodeURIComponent(node)

  const detail = await fetchDetail(nodeDecoded)

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

  const sorted = [...detail.checks].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  )
  const failCount = sorted.filter((c) => !c.success).length
  const passCount = sorted.length - failCount

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href="/compliance">← {t(locale, "common.back")}</a>
        <div>
          <h1 className="text-xl font-bold text-foreground">{t(locale, "compliance.detail.title")}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(locale, "compliance.detail.node")}: {detail.node}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="rounded-lg border bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900 px-4 py-2 text-center">
          <p className="text-xl font-bold text-green-700">{passCount}</p>
          <p className="text-xs text-green-600">{t(locale, "compliance.check.passed")}</p>
        </div>
        <div className="rounded-lg border bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900 px-4 py-2 text-center">
          <p className="text-xl font-bold text-red-700">{failCount}</p>
          <p className="text-xs text-red-600">{t(locale, "compliance.check.failed")}</p>
        </div>
        {(["Critical", "High", "Medium", "Low"] as const).map((s) =>
          detail.summary[s] > 0 ? (
            <div key={s} className={`rounded-lg border px-4 py-2 text-center ${severityBadgeClass[s]}`}>
              <p className="text-xl font-bold">{detail.summary[s]}</p>
              <p className="text-xs">{s}</p>
            </div>
          ) : null
        )}
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/30">
          <h2 className="text-sm font-semibold">{t(locale, "compliance.detail.checks")} ({sorted.length})</h2>
        </div>
        <div className="divide-y">
          {sorted.map((check) => (
            <div
              key={check.id}
              className={`p-4 text-sm ${
                check.success
                  ? "bg-green-50/30 dark:bg-green-950/10"
                  : "bg-red-50/30 dark:bg-red-950/10"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-base">{check.success ? "✓" : "✗"}</span>
                <span className="font-mono text-xs text-muted-foreground">{check.id}</span>
                <Badge className={`text-xs ${severityBadgeClass[check.severity] ?? severityBadgeClass.Unknown}`}>
                  {check.severity}
                </Badge>
              </div>
              <p className="font-medium">{translateTitle("ksv", check.id, check.title, locale)}</p>
              {check.description && (
                <p className="text-xs text-muted-foreground mt-1">{check.description}</p>
              )}
              {!check.success && check.remediation && (
                <div className="mt-2 rounded bg-background/60 p-2 text-xs border border-border">
                  <span className="font-medium">{t(locale, "compliance.check.remediation")}: </span>
                  {translateRemediation("ksv", check.id, check.remediation, locale)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
