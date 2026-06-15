import type { ArgoCDApp, HeroIncident, MascotState, HeroMode } from "./api"
import type { TimelineEvent } from "@/app/api/events/route"

export interface MyAppsResponse {
  scope: {
    groups: string[]
    namespaces: string[]
    argocdProjects: string[]
    hasMapping: boolean
  }
  scopedApps: ArgoCDApp[]
  scopedAlerts: MyAppsAlert[]
  scopedEvents: TimelineEvent[]
  hero: {
    mode: HeroMode
    mascot: MascotState
    title: string
    subtitle: string
    incidents: HeroIncident[]
  }
  generatedAt: string
}

export interface MyAppsAlert {
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: string
}
