import "server-only"
import { K8S_API_SERVER } from "./config"
import { cacheGet, cacheSet } from "./valkey"
import type { SecuritySummary, WorkloadVulnRow, ImageVulnReport, Vulnerability, Severity } from "@/types/security"

// --- K8s API helpers (local, avoids circular dep with k8s-client.ts) ---
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

async function trivyK8sFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (USE_BEARER) {
    headers["Authorization"] = `Bearer ${K8S_TOKEN}`
  }
  const res = await fetch(`${K8S_API_SERVER}${path}`, {
    headers,
    // Skip TLS verify is handled at the Node level via NODE_TLS_REJECT_UNAUTHORIZED
  })
  if (!res.ok) {
    throw new Error(`K8s API ${res.status} ${res.statusText} for ${path}`)
  }
  return res.json() as Promise<T>
}

// --- Trivy CRD types ---

interface TrivyVulnerabilityReport {
  metadata: {
    name: string
    namespace: string
    creationTimestamp?: string
    labels?: Record<string, string>
    ownerReferences?: Array<{ kind: string; name: string }>
  }
  report: {
    artifact: { repository: string; tag?: string; digest?: string }
    registry: { server: string }
    summary: {
      criticalCount: number
      highCount: number
      mediumCount: number
      lowCount: number
      unknownCount: number
      noneCount?: number
    }
    vulnerabilities: Array<{
      vulnerabilityID: string
      severity: string
      score?: number
      title: string
      description?: string
      primaryLink?: string
      fixedVersion?: string
      installedVersion?: string
      target?: string
      publishedDate?: string
      lastModifiedDate?: string
    }>
    scanner?: { name: string; vendor: string; version: string }
  }
}

interface TrivyVulnerabilityReportList {
  items: TrivyVulnerabilityReport[]
}

// --- Mapping helpers ---

function mapSeverity(raw: string): Severity {
  const s = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
  if (s === "Critical" || s === "High" || s === "Medium" || s === "Low") return s
  return "Unknown"
}

function buildImageString(report: TrivyVulnerabilityReport): string {
  const { registry, artifact } = report.report
  const server = registry.server.replace(/\/$/, "")
  const tag = artifact.tag ?? "latest"
  return `${server}/${artifact.repository}:${tag}`
}

function buildSummary(s: TrivyVulnerabilityReport["report"]["summary"]) {
  return {
    Critical: s.criticalCount,
    High: s.highCount,
    Medium: s.mediumCount,
    Low: s.lowCount,
    Unknown: s.unknownCount,
  }
}

function reportToWorkloadRow(item: TrivyVulnerabilityReport): WorkloadVulnRow {
  const labels = item.metadata.labels ?? {}
  const ownerRefs = item.metadata.ownerReferences ?? []
  const kind =
    labels["trivy-operator.resource.kind"] ??
    (ownerRefs.length > 0 ? ownerRefs[0].kind : "Pod")
  const name =
    labels["trivy-operator.resource.name"] ??
    (ownerRefs.length > 0 ? ownerRefs[0].name : item.metadata.name)
  return {
    namespace: item.metadata.namespace,
    kind,
    name,
    image: buildImageString(item),
    summary: buildSummary(item.report.summary),
  }
}

function reportToVulnerabilities(item: TrivyVulnerabilityReport): Vulnerability[] {
  return (item.report.vulnerabilities ?? []).map((v) => ({
    id: v.vulnerabilityID,
    severity: mapSeverity(v.severity),
    score: v.score,
    title: v.title,
    primaryLink: v.primaryLink,
    fixedVersion: v.fixedVersion,
    installedVersion: v.installedVersion,
    target: v.target,
    publishedDate: v.publishedDate,
  }))
}

function scoreRow(row: WorkloadVulnRow): number {
  return row.summary.Critical * 1000 + row.summary.High * 100 + row.summary.Medium * 10 + row.summary.Low
}

// --- Safe empty defaults ---

const emptySummary: SecuritySummary = {
  totals: { Critical: 0, High: 0, Medium: 0, Low: 0, Unknown: 0 },
  scannedImages: 0,
  scannedWorkloads: 0,
  lastUpdated: new Date().toISOString(),
}

// --- Exported functions (signatures unchanged) ---

export async function getSecuritySummary(): Promise<SecuritySummary> {
  const cacheKey = "security:summary"
  const cached = await cacheGet<SecuritySummary>(cacheKey)
  if (cached) return cached

  try {
    const list = await trivyK8sFetch<TrivyVulnerabilityReportList>(
      "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports",
    )
    const items = list.items ?? []

    const totals = { Critical: 0, High: 0, Medium: 0, Low: 0, Unknown: 0 }
    const imageSet = new Set<string>()
    const workloadSet = new Set<string>()
    let latestTs = ""

    for (const item of items) {
      const s = item.report.summary
      totals.Critical += s.criticalCount
      totals.High += s.highCount
      totals.Medium += s.mediumCount
      totals.Low += s.lowCount
      totals.Unknown += s.unknownCount

      imageSet.add(buildImageString(item))

      const row = reportToWorkloadRow(item)
      workloadSet.add(`${row.kind}/${row.namespace}/${row.name}`)

      const ts = item.metadata.creationTimestamp ?? ""
      if (ts > latestTs) latestTs = ts
    }

    const result: SecuritySummary = {
      totals,
      scannedImages: imageSet.size,
      scannedWorkloads: workloadSet.size,
      lastUpdated: latestTs || new Date().toISOString(),
    }

    await cacheSet(cacheKey, result, 60)
    return result
  } catch (err) {
    console.warn("[trivy] getSecuritySummary failed:", err instanceof Error ? err.message : err)
    return emptySummary
  }
}

export async function getWorkloadVulnerabilities(): Promise<WorkloadVulnRow[]> {
  const cacheKey = "security:workloads"
  const cached = await cacheGet<WorkloadVulnRow[]>(cacheKey)
  if (cached) return cached

  try {
    const list = await trivyK8sFetch<TrivyVulnerabilityReportList>(
      "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports",
    )
    const rows = (list.items ?? []).map(reportToWorkloadRow)

    await cacheSet(cacheKey, rows, 60)
    return rows
  } catch (err) {
    console.warn("[trivy] getWorkloadVulnerabilities failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getImageVulnReport(image: string): Promise<ImageVulnReport | null> {
  const cacheKey = `security:image:${image}`
  const cached = await cacheGet<ImageVulnReport>(cacheKey)
  if (cached) return cached

  try {
    const list = await trivyK8sFetch<TrivyVulnerabilityReportList>(
      "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports",
    )

    const item = (list.items ?? []).find((i) => buildImageString(i) === image)
    if (!item) return null

    const row = reportToWorkloadRow(item)
    const report: ImageVulnReport = {
      image,
      digest: item.report.artifact.digest,
      namespace: row.namespace,
      workload: { kind: row.kind, name: row.name },
      summary: row.summary,
      vulnerabilities: reportToVulnerabilities(item),
    }

    await cacheSet(cacheKey, report, 60)
    return report
  } catch (err) {
    console.warn("[trivy] getImageVulnReport failed:", err instanceof Error ? err.message : err)
    return null
  }
}

export async function getTopVulnerableImages(limit = 5): Promise<WorkloadVulnRow[]> {
  const cacheKey = `security:top-vulnerable:${limit}`
  const cached = await cacheGet<WorkloadVulnRow[]>(cacheKey)
  if (cached) return cached

  try {
    const rows = await getWorkloadVulnerabilities()
    const sorted = [...rows].sort((a, b) => scoreRow(b) - scoreRow(a))
    const result = sorted.slice(0, limit)

    await cacheSet(cacheKey, result, 60)
    return result
  } catch (err) {
    console.warn("[trivy] getTopVulnerableImages failed:", err instanceof Error ? err.message : err)
    return []
  }
}

// Re-export Severity for API route filtering
export type { Severity }
