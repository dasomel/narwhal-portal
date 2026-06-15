"use client"

import Link from "next/link"
import { Narwhal } from "@/components/narwhal/narwhal"
import { useT } from "@/lib/i18n-client"
import { useRole } from "@/hooks/use-role"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { HeroResponse, HeroIncident, HeroAction } from "@/types/api"

interface HeroRadarProps {
  data: HeroResponse
}

function IncidentRow({ incident }: { incident: HeroIncident }) {
  const { role, can } = useRole()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: ({ endpoint, body }: { endpoint: string; body: Record<string, unknown> | null }) =>
      fetch(endpoint, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => {
        if (!r.ok) throw new Error("action failed")
        return r.json()
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hero"] })
    },
  })

  const borderColor = incident.severity === "critical" ? "border-danger" : "border-warning"
  const titleColor = incident.severity === "critical" ? "text-danger" : "text-warning"

  function isAllowed(action: HeroAction): boolean {
    if (action.requiresRole === null) return true
    if (action.requiresRole === "cluster-admin") return role === "cluster-admin"
    if (action.requiresRole === "developer") return role === "cluster-admin" || role === "developer"
    return false
  }

  return (
    <div
      className={`bg-surface/70 border-l-2 ${borderColor} px-3 py-2 rounded-sm flex items-center justify-between gap-3`}
    >
      <div className="text-xs min-w-0">
        <span className={`font-semibold ${titleColor}`}>{incident.title}</span>
        <span className="text-text-secondary"> · {incident.detail}</span>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {incident.actions.filter(isAllowed).map((action) => {
          if (action.href) {
            return (
              <a
                key={action.id}
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2 py-1 bg-border-narwhal rounded text-accent-narwhal hover:bg-surface-raised whitespace-nowrap transition-colors"
              >
                {action.label}
              </a>
            )
          }
          if (action.mutationEndpoint) {
            return (
              <button
                key={action.id}
                onClick={() =>
                  mutation.mutate({
                    endpoint: action.mutationEndpoint!,
                    body: action.mutationBody,
                  })
                }
                disabled={mutation.isPending}
                className="text-xs px-2 py-1 bg-border-narwhal rounded text-accent-narwhal hover:bg-surface-raised whitespace-nowrap transition-colors disabled:opacity-50"
              >
                {action.label}
              </button>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

export function HeroRadar({ data }: HeroRadarProps) {
  const t = useT()
  const { incidents, incidentTotalCount, mascot } = data

  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0">
        <Narwhal state={mascot} size={100} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-text-primary leading-tight">
          {t("hero.incidents.needsAttention", { count: incidentTotalCount })}
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {incidents.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} />
          ))}
        </div>
        {incidentTotalCount > 5 && (
          <div className="mt-2">
            <Link
              href="/live?filter=incidents"
              className="text-xs text-accent-narwhal hover:text-accent-bright transition-colors"
            >
              {t("hero.viewAll", { count: incidentTotalCount })}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
