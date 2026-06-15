export type Severity = "Critical" | "High" | "Medium" | "Low" | "Unknown"

export type SeverityCounts = Record<Severity, number>

export interface Vulnerability {
  id: string
  severity: Severity
  score?: number
  title: string
  primaryLink?: string
  fixedVersion?: string
  installedVersion?: string
  target?: string
  publishedDate?: string
}

export interface ImageVulnReport {
  image: string
  digest?: string
  namespace: string
  workload: {
    kind: string
    name: string
  }
  summary: SeverityCounts
  vulnerabilities: Vulnerability[]
}

export interface WorkloadVulnRow {
  namespace: string
  kind: "Deployment" | "DaemonSet" | "StatefulSet" | "Job" | "Pod" | string
  name: string
  image: string
  summary: SeverityCounts
}

export interface SecuritySummary {
  totals: SeverityCounts
  scannedImages: number
  scannedWorkloads: number
  lastUpdated: string
}

export type FalcoEventPriority =
  | "Emergency"
  | "Alert"
  | "Critical"
  | "Error"
  | "Warning"
  | "Notice"
  | "Informational"
  | "Debug"

export interface FalcoEvent {
  id: string
  time: string
  priority: FalcoEventPriority
  rule: string
  output: string
  source: string
  tags?: string[]
  pod?: string
  namespace?: string
  container?: string
  image?: string
}
