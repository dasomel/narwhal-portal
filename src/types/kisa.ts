import type { Severity } from "./security"

export type KisaStatus = "pass" | "fail" | "warn" | "manual"

export interface KisaControl {
  id: string
  domain: string
  title: string
  severity: Severity
  status: KisaStatus
  standardRefs: string[]
  evidence: string
  remediation: string
  live: boolean
  detail?: string
}

export interface KisaSummary {
  total: number
  pass: number
  fail: number
  warn: number
  manual: number
  lastUpdated: string
}

export interface KisaResponse {
  controls: KisaControl[]
  summary: KisaSummary
}
