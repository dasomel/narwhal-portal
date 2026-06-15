import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { Badge } from "@/components/ui/badge"
import type { ImageVulnReport, Severity } from "@/types/security"

const severityBadgeClass: Record<Severity, string> = {
  Critical: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  High: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Medium: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Low: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  Unknown: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
}

const severityOrder: Severity[] = ["Critical", "High", "Medium", "Low", "Unknown"]

interface Props {
  params: Promise<{ image: string }>
}

async function fetchDetail(imageStr: string): Promise<ImageVulnReport | null> {
  try {
    const { getImageVulnReport } = await import("@/lib/trivy")
    return await getImageVulnReport(imageStr)
  } catch {
    return null
  }
}

export default async function ImageVulnDetailPage({ params }: Props) {
  const session = await auth()
  if (!session) redirect("/login")

  const locale = await getLocale()

  if (session.user?.role !== "cluster-admin") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="rounded-lg border bg-card p-8 max-w-md w-full text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold">{t(locale, "security.forbidden")}</h2>
        </div>
      </div>
    )
  }

  const { image: imageParam } = await params
  // base64url decode: replace URL-safe chars back then atob
  let imageStr: string
  try {
    const b64 = imageParam.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    imageStr = Buffer.from(padded, "base64").toString("utf-8")
  } catch {
    imageStr = decodeURIComponent(imageParam)
  }

  const detail = await fetchDetail(imageStr)

  if (!detail) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href="/security">← {t(locale, "common.back")}</a>
          <h1 className="text-xl font-bold">{t(locale, "security.detail.title")}</h1>
        </div>
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
          {t(locale, "common.notFound")}
        </div>
      </div>
    )
  }

  const sorted = [...detail.vulnerabilities].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
  )

  const counters: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0, Unknown: 0 }
  for (const v of detail.vulnerabilities) counters[v.severity]++

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <a className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium hover:bg-muted transition-colors" href="/security">← {t(locale, "common.back")}</a>
        <div>
          <h1 className="text-xl font-bold text-foreground">{t(locale, "security.detail.title")}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(locale, "security.detail.workload")}: {detail.namespace} / {detail.workload.kind} / {detail.workload.name}
          </p>
        </div>
      </div>

      {/* Image name */}
      <div className="rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground mb-1">{t(locale, "security.detail.image")}</p>
        <code className="font-mono text-sm break-all">{imageStr}</code>
      </div>

      {/* Severity counters */}
      <div className="flex flex-wrap gap-3">
        {severityOrder.map((s) =>
          counters[s] > 0 ? (
            <div key={s} className={`rounded-lg border px-4 py-2 text-center ${severityBadgeClass[s]}`}>
              <p className="text-xl font-bold">{counters[s]}</p>
              <p className="text-xs">{s}</p>
            </div>
          ) : null
        )}
      </div>

      {/* Full vulnerabilities table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/30">
          <h2 className="text-sm font-semibold">{t(locale, "compliance.detail.checks")} ({sorted.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground bg-muted/20">
                <th className="px-4 py-2.5 font-medium">{t(locale, "security.detail.cveId")}</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "security.detail.severity")}</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "security.detail.score")}</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "security.detail.installedVersion")}</th>
                <th className="px-4 py-2.5 font-medium">{t(locale, "security.detail.fixedVersion")}</th>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => (
                <tr key={v.id} className="border-b last:border-0 hover:bg-muted/10">
                  <td className="px-4 py-2.5 font-mono whitespace-nowrap">{v.id}</td>
                  <td className="px-4 py-2.5">
                    <Badge className={`text-xs ${severityBadgeClass[v.severity]}`}>{v.severity}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{v.score ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-muted-foreground">{v.installedVersion ?? "—"}</td>
                  <td className="px-4 py-2.5 font-mono">
                    {v.fixedVersion ? (
                      <span className="text-green-600">{v.fixedVersion}</span>
                    ) : (
                      <span className="text-muted-foreground">{t(locale, "security.detail.noFix")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 max-w-xs truncate">{v.title}</td>
                  <td className="px-4 py-2.5">
                    {v.primaryLink && (
                      <a
                        href={v.primaryLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline whitespace-nowrap"
                      >
                        {t(locale, "security.openInNvd")}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
