import type { ComponentStatus, StatusComponent } from "@/types/api"

type StatusCategory = StatusComponent["category"]

// Reuses the narwhal-success/warning/danger token convention from CatalogTable
// (src/components/catalog/catalog-table.tsx healthColors/syncColors).
export const statusBadgeClass: Record<ComponentStatus, string> = {
  healthy: "bg-narwhal-success/15 text-narwhal-success",
  degraded: "bg-narwhal-warning/15 text-narwhal-warning",
  down: "bg-narwhal-danger/15 text-narwhal-danger",
  unknown: "bg-muted text-muted-foreground",
}

export const statusDotClass: Record<ComponentStatus, string> = {
  healthy: "bg-narwhal-success",
  degraded: "bg-narwhal-warning",
  down: "bg-narwhal-danger",
  unknown: "bg-muted-foreground",
}

export const statusPillClass: Record<ComponentStatus, string> = {
  healthy: "bg-narwhal-success/15 text-narwhal-success ring-1 ring-narwhal-success/30",
  degraded: "bg-narwhal-warning/15 text-narwhal-warning ring-1 ring-narwhal-warning/30",
  down: "bg-narwhal-danger/15 text-narwhal-danger ring-1 ring-narwhal-danger/30",
  unknown: "bg-muted text-muted-foreground ring-1 ring-border",
}

export const incidentSeverityClass: Record<"critical" | "warning", string> = {
  critical: "bg-narwhal-danger/15 text-narwhal-danger",
  warning: "bg-narwhal-warning/15 text-narwhal-warning",
}

// Fixed display order for the component grid's category groups.
export const CATEGORY_ORDER: StatusCategory[] = [
  "control-plane",
  "gitops",
  "identity",
  "registry",
  "observability",
  "storage",
  "networking",
  "database",
]
