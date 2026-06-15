"use client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"

const W = 150
const H = 44

// Service-identity colors — intentional brand anchors per node role.
// Only dark-surface fills (#1e293b, #0f172a) replaced with CSS vars.
const nodes = [
  { id: "user",      label: "Developer",      x: 350, y: 20,  fill: "var(--narwhal-hero-bg, #1e293b)" },
  { id: "portal",   label: "IDP Portal",     x: 350, y: 110, fill: "var(--narwhal-accent)" },
  { id: "auth",     label: "Keycloak SSO",  x: 100, y: 200, fill: "#dc2626" },
  { id: "apisix",   label: "APISIX Gateway", x: 590, y: 200, fill: "#2563eb" },
  { id: "argocd",   label: "ArgoCD",         x: 350, y: 295, fill: "#16a34a" },
  { id: "gitea",    label: "Gitea",           x: 100, y: 295, fill: "#16a34a" },
  { id: "harbor",   label: "Harbor",          x: 590, y: 295, fill: "#16a34a" },
  { id: "grafana",  label: "Grafana",         x: 780, y: 295, fill: "#ea580c" },
  { id: "k8s",      label: "Kubernetes",      x: 350, y: 400, fill: "#374151" },
  { id: "cnpg",     label: "PostgreSQL",      x: 150, y: 490, fill: "#7c3aed" },
  { id: "seaweedfs",label: "SeaweedFS",       x: 540, y: 490, fill: "#7c3aed" },
] as const

type NodeId = typeof nodes[number]["id"]

const edges: [NodeId, NodeId][] = [
  ["user",   "portal"],
  ["portal", "auth"],
  ["portal", "apisix"],
  ["apisix", "argocd"],
  ["apisix", "gitea"],
  ["apisix", "harbor"],
  ["apisix", "grafana"],
  ["gitea",  "argocd"],
  ["argocd", "k8s"],
  ["harbor", "k8s"],
  ["k8s",    "cnpg"],
  ["k8s",    "seaweedfs"],
]

function getNode(id: NodeId) {
  return nodes.find((n) => n.id === id)!
}

function makeCurve(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

export function PlatformDiagram() {
  const t = useT()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("onboarding.architecture")}</CardTitle>
      </CardHeader>
      <CardContent>
        <svg
          viewBox="0 0 1000 580"
          className="w-full max-w-4xl mx-auto"
          role="img"
          aria-label="Narwhal IDP platform architecture diagram"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 12 12"
              refX="11"
              refY="6"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 11 6 L 0 11 z" fill="var(--muted-foreground)" />
            </marker>
            <filter id="shadow" x="-4%" y="-4%" width="108%" height="108%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.18" />
            </filter>
          </defs>

          {/* Access Layer background */}
          <rect x="20" y="10" width="960" height="255" rx="12" fill="var(--narwhal-accent)" fillOpacity="0.06" stroke="var(--narwhal-accent)" strokeOpacity="0.2" strokeWidth="1" />
          <text x="30" y="26" fontSize="10" fill="var(--muted-foreground)" fontFamily="system-ui, sans-serif">Access Layer</text>

          {/* Application Layer background */}
          <rect x="20" y="275" width="960" height="100" rx="12" fill="var(--narwhal-success)" fillOpacity="0.06" stroke="var(--narwhal-success)" strokeOpacity="0.2" strokeWidth="1" />
          <text x="30" y="291" fontSize="10" fill="var(--muted-foreground)" fontFamily="system-ui, sans-serif">Application Layer</text>

          {/* Infrastructure Layer background */}
          <rect x="20" y="385" width="960" height="175" rx="12" fill="var(--muted)" fillOpacity="0.5" stroke="var(--border)" strokeWidth="1" />
          <text x="30" y="401" fontSize="10" fill="var(--muted-foreground)" fontFamily="system-ui, sans-serif">Infrastructure Layer</text>

          {/* Edges */}
          {edges.map(([from, to]) => {
            const a = getNode(from)
            const b = getNode(to)
            const x1 = a.x + W / 2
            const y1 = a.y + H
            const x2 = b.x + W / 2
            const y2 = b.y
            return (
              <path
                key={`${from}-${to}`}
                d={makeCurve(x1, y1, x2, y2)}
                fill="none"
                stroke="var(--muted-foreground)"
                strokeOpacity="0.5"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            )
          })}

          {/* Nodes */}
          {nodes.map((n) => (
            <g key={n.id} filter="url(#shadow)">
              <rect
                x={n.x}
                y={n.y}
                width={W}
                height={H}
                rx={10}
                fill={n.fill}
              />
              <text
                x={n.x + W / 2}
                y={n.y + H / 2 + 1}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={13}
                fontWeight={600}
                fontFamily="system-ui, sans-serif"
                fill="white"
              >
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </CardContent>
    </Card>
  )
}
