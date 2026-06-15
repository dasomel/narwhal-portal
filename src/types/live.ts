export type LiveEventType = "alert" | "deploy" | "sync" | "node" | "custom"
export type LiveSeverity = "info" | "success" | "warning" | "error"
export type LiveSource = "alertmanager" | "argocd" | "kubernetes" | "manual"

export interface LiveEvent {
  id: string // UUID
  type: LiveEventType
  severity: LiveSeverity
  timestamp: string // ISO8601
  title: string
  description: string
  source: LiveSource
  links: { label: string; href: string }[] | null
}

export interface LiveEventIngest {
  type: LiveEventType
  severity: LiveSeverity
  title: string
  description: string
  source: LiveSource
  links?: { label: string; href: string }[]
}
