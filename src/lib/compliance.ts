import "server-only"
import { K8S_API_SERVER } from "./config"
import { cacheGet, cacheSet } from "./valkey"
import type {
  Severity,
  CheckSummary,
  AuditCheck,
  ConfigAuditRow,
  ConfigAuditDetail,
  RbacAuditRow,
  RbacAuditDetail,
  InfraAuditRow,
  InfraAuditDetail,
  ComplianceFramework,
  ComplianceFrameworkDetail,
  ComplianceControl,
  ComplianceSummary,
} from "@/types/compliance"

// --- K8s API helpers ---
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

async function complianceK8sFetch<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (USE_BEARER) {
    headers["Authorization"] = `Bearer ${K8S_TOKEN}`
  }
  const res = await fetch(`${K8S_API_SERVER}${path}`, { headers })
  if (!res.ok) {
    throw new Error(`K8s API ${res.status} ${res.statusText} for ${path}`)
  }
  return res.json() as Promise<T>
}

// --- CRD raw types ---

interface RawCheck {
  checkID: string
  title: string
  description?: string
  severity: string
  category?: string
  success: boolean
  messages?: string[]
  remediation?: string
}

interface RawAuditSummary {
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
}

interface RawAuditReport {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  report: {
    summary: RawAuditSummary
    checks: RawCheck[]
  }
}

interface RawAuditList {
  items: RawAuditReport[]
}

interface RawComplianceReport {
  metadata: {
    name: string
    creationTimestamp?: string
  }
  spec: {
    compliance: {
      id: string
      title: string
      controls?: Array<{
        id: string
        name: string
        severity: string
        description?: string
      }>
    }
  }
  status?: {
    summary?: {
      passCount?: number
      failCount?: number
    }
    detailReport?: {
      controls: Array<{
        id: string
        name: string
        severity: string
        passTotal: number
        failTotal: number
        description?: string
      }>
    }
  }
}

interface RawComplianceList {
  items: RawComplianceReport[]
}

// --- Mapping helpers ---

function mapSeverity(raw: string): Severity {
  const s = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
  if (s === "Critical" || s === "High" || s === "Medium" || s === "Low") return s
  return "Unknown"
}

function buildCheckSummaryFromFailures(checks: RawCheck[]): CheckSummary {
  const summary: CheckSummary = { Critical: 0, High: 0, Medium: 0, Low: 0 }
  for (const c of checks) {
    if (c.success) continue
    const sev = mapSeverity(c.severity)
    if (sev === "Unknown") continue
    summary[sev]++
  }
  return summary
}

function buildCheckSummaryFromCounts(raw: RawAuditSummary): CheckSummary {
  return {
    Critical: raw.criticalCount,
    High: raw.highCount,
    Medium: raw.mediumCount,
    Low: raw.lowCount,
  }
}

function mapChecks(rawChecks: RawCheck[]): AuditCheck[] {
  // Trivy가 동일 checkID + success 조합을 여러 번 emit하는 경우가 있어 dedup.
  // (Pod 안 여러 컨테이너가 같은 정책에 동시 실패하면 동일 항목 반복)
  const seen = new Set<string>()
  const deduped: RawCheck[] = []
  for (const c of rawChecks) {
    const key = `${c.checkID}|${c.success}|${(c.messages ?? []).join("\n")}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }
  return deduped.map((c) => ({
    id: c.checkID,
    title: c.title,
    description: c.description,
    severity: mapSeverity(c.severity),
    category: c.category,
    success: c.success,
    messages: c.messages,
    remediation: c.remediation,
  }))
}

function addSummaries(a: CheckSummary, b: CheckSummary): CheckSummary {
  return {
    Critical: a.Critical + b.Critical,
    High: a.High + b.High,
    Medium: a.Medium + b.Medium,
    Low: a.Low + b.Low,
  }
}

const emptyCheckSummary: CheckSummary = { Critical: 0, High: 0, Medium: 0, Low: 0 }

// --- getConfigAuditList ---

export async function getConfigAuditList(): Promise<ConfigAuditRow[]> {
  const cacheKey = "compliance:config-audit:list"
  const cached = await cacheGet<ConfigAuditRow[]>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawAuditList>(
      "/apis/aquasecurity.github.io/v1alpha1/configauditreports",
    )
    const rows: ConfigAuditRow[] = (list.items ?? []).map((item) => {
      const labels = item.metadata.labels ?? {}
      const kind = labels["trivy-operator.resource.kind"] ?? "Unknown"
      const name = labels["trivy-operator.resource.name"] ?? item.metadata.name
      return {
        namespace: item.metadata.namespace ?? "",
        kind,
        name,
        summary: buildCheckSummaryFromCounts(item.report.summary),
      }
    })
    await cacheSet(cacheKey, rows, 60)
    return rows
  } catch (err) {
    console.warn("[compliance] getConfigAuditList failed:", err instanceof Error ? err.message : err)
    return []
  }
}

// --- getConfigAuditDetail ---

export async function getConfigAuditDetail(
  namespace: string,
  name: string,
): Promise<ConfigAuditDetail | null> {
  const cacheKey = `compliance:config-audit:${namespace}:${name}`
  const cached = await cacheGet<ConfigAuditDetail>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawAuditList>(
      "/apis/aquasecurity.github.io/v1alpha1/configauditreports",
    )
    const item = (list.items ?? []).find((i) => {
      const labels = i.metadata.labels ?? {}
      const rName = labels["trivy-operator.resource.name"] ?? i.metadata.name
      return i.metadata.namespace === namespace && rName === name
    })
    if (!item) return null

    const labels = item.metadata.labels ?? {}
    const kind = labels["trivy-operator.resource.kind"] ?? "Unknown"
    const rName = labels["trivy-operator.resource.name"] ?? item.metadata.name
    const checks = mapChecks(item.report.checks ?? [])
    const detail: ConfigAuditDetail = {
      namespace: item.metadata.namespace ?? "",
      kind,
      name: rName,
      summary: buildCheckSummaryFromCounts(item.report.summary),
      checks,
    }
    await cacheSet(cacheKey, detail, 60)
    return detail
  } catch (err) {
    console.warn("[compliance] getConfigAuditDetail failed:", err instanceof Error ? err.message : err)
    return null
  }
}

// --- getRbacAuditList ---

export async function getRbacAuditList(): Promise<RbacAuditRow[]> {
  const cacheKey = "compliance:rbac-audit:list"
  const cached = await cacheGet<RbacAuditRow[]>(cacheKey)
  if (cached) return cached

  try {
    const [namespaced, clustered] = await Promise.all([
      complianceK8sFetch<RawAuditList>(
        "/apis/aquasecurity.github.io/v1alpha1/rbacassessmentreports",
      ).catch(() => ({ items: [] as RawAuditReport[] })),
      complianceK8sFetch<RawAuditList>(
        "/apis/aquasecurity.github.io/v1alpha1/clusterrbacassessmentreports",
      ).catch(() => ({ items: [] as RawAuditReport[] })),
    ])

    const allItems = [...(namespaced.items ?? []), ...(clustered.items ?? [])]
    const rows: RbacAuditRow[] = allItems.map((item) => {
      const labels = item.metadata.labels ?? {}
      const kind = labels["trivy-operator.resource.kind"] ?? "Unknown"
      const name = labels["trivy-operator.resource.name"] ?? item.metadata.name
      return {
        namespace: item.metadata.namespace ?? "",
        kind,
        name,
        summary: buildCheckSummaryFromCounts(item.report.summary),
      }
    })
    await cacheSet(cacheKey, rows, 60)
    return rows
  } catch (err) {
    console.warn("[compliance] getRbacAuditList failed:", err instanceof Error ? err.message : err)
    return []
  }
}

// --- getRbacAuditDetail ---

export async function getRbacAuditDetail(
  namespace: string,
  name: string,
): Promise<RbacAuditDetail | null> {
  const cacheKey = `compliance:rbac-audit:${namespace}:${name}`
  const cached = await cacheGet<RbacAuditDetail>(cacheKey)
  if (cached) return cached

  try {
    const [namespaced, clustered] = await Promise.all([
      complianceK8sFetch<RawAuditList>(
        "/apis/aquasecurity.github.io/v1alpha1/rbacassessmentreports",
      ).catch(() => ({ items: [] as RawAuditReport[] })),
      complianceK8sFetch<RawAuditList>(
        "/apis/aquasecurity.github.io/v1alpha1/clusterrbacassessmentreports",
      ).catch(() => ({ items: [] as RawAuditReport[] })),
    ])

    const allItems = [...(namespaced.items ?? []), ...(clustered.items ?? [])]
    const item = allItems.find((i) => {
      const labels = i.metadata.labels ?? {}
      const rName = labels["trivy-operator.resource.name"] ?? i.metadata.name
      const rNamespace = i.metadata.namespace ?? ""
      return rNamespace === namespace && rName === name
    })
    if (!item) return null

    const labels = item.metadata.labels ?? {}
    const kind = labels["trivy-operator.resource.kind"] ?? "Unknown"
    const rName = labels["trivy-operator.resource.name"] ?? item.metadata.name
    const checks = mapChecks(item.report.checks ?? [])
    const detail: RbacAuditDetail = {
      namespace: item.metadata.namespace ?? "",
      kind,
      name: rName,
      summary: buildCheckSummaryFromCounts(item.report.summary),
      checks,
    }
    await cacheSet(cacheKey, detail, 60)
    return detail
  } catch (err) {
    console.warn("[compliance] getRbacAuditDetail failed:", err instanceof Error ? err.message : err)
    return null
  }
}

// --- getInfraAuditList ---

export async function getInfraAuditList(): Promise<InfraAuditRow[]> {
  const cacheKey = "compliance:infra-audit:list"
  const cached = await cacheGet<InfraAuditRow[]>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawAuditList>(
      "/apis/aquasecurity.github.io/v1alpha1/infraassessmentreports",
    )
    const rows: InfraAuditRow[] = (list.items ?? []).map((item) => {
      const labels = item.metadata.labels ?? {}
      const node = labels["trivy-operator.resource.name"] ?? item.metadata.name
      return {
        node,
        summary: buildCheckSummaryFromCounts(item.report.summary),
      }
    })
    await cacheSet(cacheKey, rows, 60)
    return rows
  } catch (err) {
    console.warn("[compliance] getInfraAuditList failed:", err instanceof Error ? err.message : err)
    return []
  }
}

// --- getInfraAuditDetail ---

export async function getInfraAuditDetail(node: string): Promise<InfraAuditDetail | null> {
  const cacheKey = `compliance:infra-audit:${node}`
  const cached = await cacheGet<InfraAuditDetail>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawAuditList>(
      "/apis/aquasecurity.github.io/v1alpha1/infraassessmentreports",
    )
    const item = (list.items ?? []).find((i) => {
      const labels = i.metadata.labels ?? {}
      const rName = labels["trivy-operator.resource.name"] ?? i.metadata.name
      return rName === node
    })
    if (!item) return null

    const labels = item.metadata.labels ?? {}
    const rNode = labels["trivy-operator.resource.name"] ?? item.metadata.name
    const checks = mapChecks(item.report.checks ?? [])
    const detail: InfraAuditDetail = {
      node: rNode,
      summary: buildCheckSummaryFromCounts(item.report.summary),
      checks,
    }
    await cacheSet(cacheKey, detail, 60)
    return detail
  } catch (err) {
    console.warn("[compliance] getInfraAuditDetail failed:", err instanceof Error ? err.message : err)
    return null
  }
}

// --- getComplianceFrameworks ---

export async function getComplianceFrameworks(): Promise<ComplianceFramework[]> {
  const cacheKey = "compliance:frameworks:list"
  const cached = await cacheGet<ComplianceFramework[]>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawComplianceList>(
      "/apis/aquasecurity.github.io/v1alpha1/clustercompliancereports",
    )
    const frameworks: ComplianceFramework[] = (list.items ?? []).map((item) => {
      const passCount = item.status?.summary?.passCount ?? 0
      const failCount = item.status?.summary?.failCount ?? 0
      // totalControls는 spec 정의 기준이 정확 (summary는 평가된 항목만 카운트)
      const totalControls = (item.spec.compliance.controls?.length ?? 0) || passCount + failCount
      const evaluated = passCount + failCount
      const passRate = evaluated > 0 ? passCount / evaluated : 0
      return {
        id: item.spec.compliance.id,
        title: item.spec.compliance.title,
        passCount,
        failCount,
        totalControls,
        passRate,
      }
    })
    await cacheSet(cacheKey, frameworks, 60)
    return frameworks
  } catch (err) {
    console.warn("[compliance] getComplianceFrameworks failed:", err instanceof Error ? err.message : err)
    return []
  }
}

// --- getComplianceFrameworkDetail ---

export async function getComplianceFrameworkDetail(
  id: string,
): Promise<ComplianceFrameworkDetail | null> {
  const cacheKey = `compliance:frameworks:${id}`
  const cached = await cacheGet<ComplianceFrameworkDetail>(cacheKey)
  if (cached) return cached

  try {
    const list = await complianceK8sFetch<RawComplianceList>(
      "/apis/aquasecurity.github.io/v1alpha1/clustercompliancereports",
    )
    const item = (list.items ?? []).find((i) => i.spec.compliance.id === id)
    if (!item) return null

    const aggPass = item.status?.summary?.passCount ?? 0
    const aggFail = item.status?.summary?.failCount ?? 0

    // status.detailReport.controls 가 있으면 per-control 사용, 없으면 spec.compliance.controls 폴백
    // (Trivy spec.reportType=summary 이면 detailReport 비어있음 — 정의만 표시, pass/fail은 0으로)
    const detailControls = item.status?.detailReport?.controls ?? []
    const specControls = item.spec.compliance.controls ?? []

    let controls: ComplianceControl[]
    if (detailControls.length > 0) {
      controls = detailControls.map((c) => ({
        id: c.id,
        name: c.name,
        severity: mapSeverity(c.severity),
        passCount: c.passTotal,
        failCount: c.failTotal,
        description: c.description,
      }))
    } else {
      controls = specControls.map((c) => ({
        id: c.id,
        name: c.name,
        severity: mapSeverity(c.severity),
        passCount: 0,
        failCount: 0,
        description: c.description,
      }))
    }

    const passCount = aggPass
    const failCount = aggFail
    const totalControls = controls.length || aggPass + aggFail
    const passRate = totalControls > 0 ? aggPass / (aggPass + aggFail || totalControls) : 0

    const detail: ComplianceFrameworkDetail = {
      id: item.spec.compliance.id,
      title: item.spec.compliance.title,
      passCount,
      failCount,
      totalControls,
      passRate,
      controls,
    }
    await cacheSet(cacheKey, detail, 60)
    return detail
  } catch (err) {
    console.warn("[compliance] getComplianceFrameworkDetail failed:", err instanceof Error ? err.message : err)
    return null
  }
}

// --- getComplianceSummary ---

export async function getComplianceSummary(): Promise<ComplianceSummary> {
  const cacheKey = "compliance:summary"
  const cached = await cacheGet<ComplianceSummary>(cacheKey)
  if (cached) return cached

  try {
    const [configAuditList, rbacAuditList, infraAuditList, frameworks] = await Promise.all([
      getConfigAuditList(),
      getRbacAuditList(),
      getInfraAuditList(),
      getComplianceFrameworks(),
    ])

    const totalConfigAuditFailures = configAuditList.reduce(
      (acc, row) => addSummaries(acc, row.summary),
      { ...emptyCheckSummary },
    )
    const totalRbacFailures = rbacAuditList.reduce(
      (acc, row) => addSummaries(acc, row.summary),
      { ...emptyCheckSummary },
    )
    const totalInfraFailures = infraAuditList.reduce(
      (acc, row) => addSummaries(acc, row.summary),
      { ...emptyCheckSummary },
    )

    // Derive lastUpdated from K8s timestamps via a separate fetch
    let lastUpdated = new Date().toISOString()
    try {
      const [configList, rbacNs, rbacCluster, infraList, ccList] = await Promise.all([
        complianceK8sFetch<RawAuditList>("/apis/aquasecurity.github.io/v1alpha1/configauditreports").catch(() => ({ items: [] as RawAuditReport[] })),
        complianceK8sFetch<RawAuditList>("/apis/aquasecurity.github.io/v1alpha1/rbacassessmentreports").catch(() => ({ items: [] as RawAuditReport[] })),
        complianceK8sFetch<RawAuditList>("/apis/aquasecurity.github.io/v1alpha1/clusterrbacassessmentreports").catch(() => ({ items: [] as RawAuditReport[] })),
        complianceK8sFetch<RawAuditList>("/apis/aquasecurity.github.io/v1alpha1/infraassessmentreports").catch(() => ({ items: [] as RawAuditReport[] })),
        complianceK8sFetch<RawComplianceList>("/apis/aquasecurity.github.io/v1alpha1/clustercompliancereports").catch(() => ({ items: [] as RawComplianceReport[] })),
      ])
      const allTs = [
        ...(configList.items ?? []),
        ...(rbacNs.items ?? []),
        ...(rbacCluster.items ?? []),
        ...(infraList.items ?? []),
      ]
        .map((i) => i.metadata.creationTimestamp ?? "")
        .concat((ccList.items ?? []).map((i) => i.metadata.creationTimestamp ?? ""))
        .filter(Boolean)
        .sort()
      if (allTs.length > 0) lastUpdated = allTs[allTs.length - 1]
    } catch {
      // lastUpdated stays as now
    }

    const result: ComplianceSummary = {
      totalConfigAuditFailures,
      totalRbacFailures,
      totalInfraFailures,
      frameworks,
      scannedWorkloads: configAuditList.length,
      scannedRbacObjects: rbacAuditList.length,
      scannedNodes: infraAuditList.length,
      lastUpdated,
    }
    await cacheSet(cacheKey, result, 60)
    return result
  } catch (err) {
    console.warn("[compliance] getComplianceSummary failed:", err instanceof Error ? err.message : err)
    return {
      totalConfigAuditFailures: { ...emptyCheckSummary },
      totalRbacFailures: { ...emptyCheckSummary },
      totalInfraFailures: { ...emptyCheckSummary },
      frameworks: [],
      scannedWorkloads: 0,
      scannedRbacObjects: 0,
      scannedNodes: 0,
      lastUpdated: new Date().toISOString(),
    }
  }
}
