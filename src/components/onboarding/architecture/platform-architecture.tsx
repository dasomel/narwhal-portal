"use client"

import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import type { ArchitectureData } from "@/app/api/architecture/route"

const STATUS_COLORS: Record<string, string> = {
  healthy: "var(--narwhal-success)",
  degraded: "var(--narwhal-warning)",
  offline: "var(--narwhal-danger)",
  unknown: "var(--muted-foreground)",
}

// Layered hierarchy following the dependency flow, widely spaced to minimise
// node/edge overlap (viewBox 0 0 920 560, box W=120/H=36).
//  L0: portal            L1: keycloak · apisix
//  L2: grafana · argocd · gitea · harbor   L3: prometheus · openbao   L4: k8s
const LAYOUT = [
  { id: "portal", label: "IDP Portal", x: 400, y: 30 },
  { id: "keycloak", label: "Keycloak SSO", x: 180, y: 150 },
  { id: "apisix", label: "APISIX", x: 540, y: 150 },
  { id: "grafana", label: "Grafana", x: 40, y: 290 },
  { id: "argocd", label: "ArgoCD", x: 300, y: 290 },
  { id: "gitea", label: "Gitea", x: 500, y: 290 },
  { id: "harbor", label: "Harbor", x: 740, y: 290 },
  { id: "prometheus", label: "Prometheus", x: 40, y: 410 },
  { id: "openbao", label: "OpenBao", x: 740, y: 410 },
  { id: "k8s", label: "Kubernetes", x: 400, y: 500 },
]

const EDGES: [string, string][] = [
  ["portal", "keycloak"],
  ["portal", "apisix"],
  ["apisix", "argocd"],
  ["apisix", "gitea"],
  ["apisix", "harbor"],
  ["apisix", "grafana"],
  ["gitea", "argocd"],
  ["argocd", "k8s"],
  ["harbor", "k8s"],
  ["prometheus", "k8s"],
  ["grafana", "prometheus"],
  ["openbao", "k8s"],
]

const W = 120
const H = 36

export function PlatformArchitecture() {
  const t = useT()

  const { data } = useQuery<ArchitectureData>({
    queryKey: ["architecture"],
    queryFn: () => fetch("/api/architecture").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const statusMap = new Map(data?.nodes.map((n) => [n.id, n.status]) ?? [])
  const healthy = data ? data.nodes.filter((n) => n.status === "healthy").length : 0
  const total = data?.nodes.length ?? 0

  function getPos(id: string) {
    return LAYOUT.find((n) => n.id === id)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{t("arch.title")}</CardTitle>
          {total > 0 && (
            <Badge variant="outline" className="text-xs">
              {t("arch.healthCount", { healthy, total })}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox="0 0 920 560"
          className="w-full max-w-3xl mx-auto"
          role="img"
          aria-label="Narwhal IDP platform architecture diagram"
        >
          <defs>
            <marker id="arrow-pa" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
            </marker>
          </defs>

          {EDGES.map(([from, to]) => {
            const a = getPos(from)
            const b = getPos(to)
            if (!a || !b) return null
            return (
              <line
                key={`${from}-${to}`}
                x1={a.x + W / 2} y1={a.y + H}
                x2={b.x + W / 2} y2={b.y}
                stroke="var(--border)" strokeWidth={1.5}
                markerEnd="url(#arrow-pa)"
              />
            )
          })}

          {LAYOUT.map((n) => {
            const status = statusMap.get(n.id) ?? "unknown"
            const color = STATUS_COLORS[status]
            return (
              <g key={n.id}>
                <rect x={n.x} y={n.y} width={W} height={H} rx={8} fill="var(--card)" stroke="var(--border)" strokeWidth={1.5} />
                <circle cx={n.x + 10} cy={n.y + H / 2} r={4} fill={color} />
                <text
                  x={n.x + W / 2 + 4} y={n.y + H / 2}
                  textAnchor="middle" dominantBaseline="central"
                  fontSize={11} fontFamily="system-ui, sans-serif" fill="var(--foreground)"
                >
                  {n.label}
                </text>
              </g>
            )
          })}
        </svg>

        <div className="flex gap-4 justify-center mt-3">
          {Object.entries(STATUS_COLORS).map(([status]) => (
            <div key={status} className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: STATUS_COLORS[status] }} />
              {t(`arch.${status}` as Parameters<typeof t>[0])}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
