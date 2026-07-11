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
  /** true when `name` (the owning Role/ClusterRole) is a Kubernetes built-in role (system:*,
   *  kubeadm:*, cluster-admin/admin/edit/view) or an upstream controller/chart-owned role —
   *  findings are inherent to what that role does and are not actionable by the platform team. */
  accepted: boolean
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
   *  in lib/compliance.ts) AND excludes LOW severity (see lowSeverityConfigAuditFailures below;
   *  KSV020/021 UID/GID, KSV011/015/016/018 resource limits are risk-accepted hygiene checks per
   *  narwhal/docs/compliance-hardening.md). Reclassified 2026-07; field name kept for API compat. */
  totalConfigAuditFailures: CheckSummary
  /** NEW: LOW-severity config-audit failures in non-system namespaces — risk-accepted hygiene
   *  checks, shown separately so they don't inflate the actionable headline. Only the `Low` field
   *  is ever non-zero here (Critical/High/Medium always 0 by construction). */
  lowSeverityConfigAuditFailures: CheckSummary
  /** NEW: config-audit failures in system namespaces (kube-system/istio-system/…), inherent to
   *  K8s/CNI/mesh and not actionable — kept visible separately rather than dropped. */
  acceptedSystemConfigAuditFailures: CheckSummary
  /** ACTIONABLE RBAC-audit failures only — excludes findings owned by Kubernetes built-in roles
   *  and upstream controller/chart roles (see isAcceptedRbacRole in lib/compliance.ts). Field
   *  name kept for API compat; reclassified 2026-07. */
  totalRbacFailures: CheckSummary
  /** NEW: RBAC-audit failures owned by built-in K8s roles or upstream controllers/charts —
   *  inherent to what those roles do and not actionable, shown separately rather than dropped. */
  acceptedRbacFailures: CheckSummary
  totalInfraFailures: CheckSummary
  frameworks: ComplianceFramework[]
  scannedWorkloads: number
  scannedRbacObjects: number
  scannedNodes: number
  lastUpdated: string
}
