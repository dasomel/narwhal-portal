"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import { useT } from "@/lib/i18n-client"
import { ClusterInfraView } from "./cluster-infra-view"
import { ServiceMapView } from "./service-map-view"

type View = "infra" | "services"

export function ArchitectureView() {
  const t = useT()
  const params = useSearchParams()
  const initial: View = params.get("view") === "services" ? "services" : "infra"
  const focus = params.get("focus") ?? undefined
  const [view, setView] = useState<View>(initial)

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {(["infra", "services"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              view === v
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(v === "infra" ? "architecture.view.infra" : "architecture.view.services")}
          </button>
        ))}
      </div>
      {view === "infra" ? <ClusterInfraView /> : <ServiceMapView focusService={focus} />}
    </div>
  )
}
