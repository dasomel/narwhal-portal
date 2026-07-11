import type { Severity } from "./security"
export type { Severity }

export interface CheckSummary {
  Critical: number
  High: number
  Medium: number
  Low: number
}

export interface AuditCheck {
  id: string
  title: string
  description?: string
  severity: Severity
  category?: string
  success: boolean
  messages?: string[]
  remediation?: string
}

export interface ConfigAuditRow {
  namespace: string
  kind: string
  name: string
  summary: CheckSummary
  /** true when `namespace` is a system namespace (kube-system/istio-system/…) — findings are
   *  inherent to K8s static pods/CNI/mesh and are not actionable by the platform team. */
  accepted: boolean
}

export interface ConfigAuditDetail extends ConfigAuditRow {
  checks: AuditCheck[]
}

export interface RbacAuditRow {
  namespace: string
  kind: string
  name: string
  summary: CheckSummary
}

export interface RbacAuditDetail extends RbacAuditRow {
  checks: AuditCheck[]
}

export interface InfraAuditRow {
  node: string
  summary: CheckSummary
}

export interface InfraAuditDetail extends InfraAuditRow {
  checks: AuditCheck[]
}

export interface ComplianceFramework {
  id: string
  title: string
  passCount: number
  failCount: number
  totalControls: number
  passRate: number
}

export interface ComplianceControl {
  id: string
  name: string
  severity: Severity
  passCount: number
  failCount: number
  description?: string
}

export interface ComplianceFrameworkDetail extends ComplianceFramework {
  controls: ComplianceControl[]
}

export interface ComplianceSummary {
  /** ACTIONABLE config-audit failures only — excludes system namespaces (see SYSTEM_NAMESPACES
   *  in lib/compliance.ts). Reclassified 2026-07; field name kept for API compatibility. */
  totalConfigAuditFailures: CheckSummary
  /** NEW: config-audit failures in system namespaces (kube-system/istio-system/…), inherent to
   *  K8s/CNI/mesh and not actionable — kept visible separately rather than dropped. */
  acceptedSystemConfigAuditFailures: CheckSummary
  totalRbacFailures: CheckSummary
  totalInfraFailures: CheckSummary
  frameworks: ComplianceFramework[]
  scannedWorkloads: number
  scannedRbacObjects: number
  scannedNodes: number
  lastUpdated: string
}
