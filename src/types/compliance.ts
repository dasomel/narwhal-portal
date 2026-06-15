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
  totalConfigAuditFailures: CheckSummary
  totalRbacFailures: CheckSummary
  totalInfraFailures: CheckSummary
  frameworks: ComplianceFramework[]
  scannedWorkloads: number
  scannedRbacObjects: number
  scannedNodes: number
  lastUpdated: string
}
