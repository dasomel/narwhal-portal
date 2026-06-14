import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getLocale } from "@/lib/i18n-server"
import { t } from "@/lib/i18n"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SeverityCounters } from "@/components/security/severity-counters"
import { SeverityDistributionChart } from "@/components/security/severity-distribution-chart"
import { VulnerabilitiesTable } from "@/components/security/vulnerabilities-table"
import { RuntimeEventsFeed } from "@/components/security/runtime-events-feed"
import type { SecuritySummary, WorkloadVulnRow } from "@/types/security"
import type { ClusterInfra } from "@/app/api/cluster/route"
import { cacheGet } from "@/lib/valkey"

async function detectUbuntu2604(): Promise<boolean> {
  try {
    const cached = await cacheGet<ClusterInfra>("cluster:infra")
    if (cached) {
      return cached.nodes.some((n) => n.osImage.includes("26.04"))
    }
  } catch {
    // cache unavailable — fall through
  }
  return false
}

async function fetchSecuritySummary(): Promise<SecuritySummary | null> {
  try {
    const { getSecuritySummary } = await import("@/lib/trivy")
    return await getSecuritySummary()
  } catch {
    return null
  }
}

async function fetchWorkloadVulnerabilities(): Promise<WorkloadVulnRow[]> {
  try {
    const { getWorkloadVulnerabilities } = await import("@/lib/trivy")
    return await getWorkloadVulnerabilities()
  } catch {
    return []
  }
}

const emptySummary: SecuritySummary = {
  totals: { Critical: 0, High: 0, Medium: 0, Low: 0, Unknown: 0 },
  scannedImages: 0,
  scannedWorkloads: 0,
  lastUpdated: new Date().toISOString(),
}

function totalVulns(row: WorkloadVulnRow): number {
  const s = row.summary
  return s.Critical + s.High + s.Medium + s.Low + s.Unknown
}

const severityDotClass: Record<string, string> = {
  Critical: "bg-red-600",
  High: "bg-orange-500",
  Medium: "bg-amber-500",
  Low: "bg-blue-500",
  Unknown: "bg-gray-500",
}

export default async function SecurityPage() {
  const session = await auth()
  if (!session) redirect("/login")

  if (session.user?.role !== "cluster-admin") {
    const locale = await getLocale()
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="rounded-lg border bg-card p-8 max-w-md w-full text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold text-foreground">{t(locale, "security.forbidden")}</h2>
          <p className="text-sm text-muted-foreground">{t(locale, "security.subtitle")}</p>
        </div>
      </div>
    )
  }

  const locale = await getLocale()
  const [summary, initialVulns, is2604] = await Promise.all([
    fetchSecuritySummary(),
    fetchWorkloadVulnerabilities(),
    detectUbuntu2604(),
  ])

  const effectiveSummary = summary ?? emptySummary

  // Top 5 images by total vuln count (server-computed)
  const top5 = [...initialVulns]
    .sort((a, b) => totalVulns(b) - totalVulns(a))
    .slice(0, 5)

  return (
    <div className="space-y-6">
      {/* 1. Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "security.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "security.subtitle")}</p>
      </div>

      {/* 2. Counter cards */}
      <SeverityCounters summary={effectiveSummary} locale={locale} />

      {/* 3. Severity distribution chart */}
      <SeverityDistributionChart summary={effectiveSummary} />

      {/* 4. Top 5 vulnerable images */}
      {top5.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            {t(locale, "security.top.title")}
          </h2>
          <ul className="space-y-2">
            {top5.map((row, idx) => (
              <li key={`${row.namespace}/${row.name}/${row.image}`} className="flex items-center gap-3 text-sm">
                <span className="text-xs text-muted-foreground w-4 text-right shrink-0">{idx + 1}</span>
                <code className="font-mono text-xs truncate flex-1 min-w-0 text-foreground">{row.image}</code>
                <span className="text-xs text-muted-foreground shrink-0">{row.namespace}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {(["Critical", "High", "Medium", "Low"] as const).map((s) =>
                    row.summary[s] > 0 ? (
                      <span
                        key={s}
                        className={`text-xs px-1.5 py-0.5 rounded font-medium text-white ${severityDotClass[s]}`}
                      >
                        {row.summary[s]}
                      </span>
                    ) : null
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Tabs: Vulnerabilities | Runtime Events (hidden on Ubuntu 26.04 — Falco unsupported) */}
      <Tabs defaultValue="vulnerabilities">
        <TabsList>
          <TabsTrigger value="vulnerabilities">{t(locale, "security.tab.vulnerabilities")}</TabsTrigger>
          {!is2604 && (
            <TabsTrigger value="runtime">{t(locale, "security.tab.runtime")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="vulnerabilities" className="mt-4">
          <VulnerabilitiesTable initialData={initialVulns} />
        </TabsContent>
        {is2604 ? (
          <div className="mt-4 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            {t(locale, "security.runtimeEvents.unavailable2604")}
          </div>
        ) : (
          <TabsContent value="runtime" className="mt-4">
            <RuntimeEventsFeed />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
