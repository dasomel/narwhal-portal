export interface ServiceTemplate {
  id: string
  name: string
  description: string
  stack: string[]
  fields: Array<{ name: string; label: string; type: "text" | "select"; options?: string[]; required: boolean }>
}

export const TEMPLATES: ServiceTemplate[] = [
  {
    id: "nextjs-web",
    name: "Next.js Web App",
    description: "Next.js + React fullstack application with ArgoCD GitOps",
    stack: ["Next.js", "React", "TypeScript", "ArgoCD"],
    fields: [
      { name: "serviceName", label: "Service Name", type: "text", required: true },
      { name: "namespace", label: "Namespace", type: "text", required: true },
      { name: "replicas", label: "Replicas", type: "select", options: ["1", "2", "3"], required: true },
    ],
  },
  {
    id: "api-service",
    name: "REST API Service",
    description: "Go/Node.js API service with database and monitoring",
    stack: ["Go", "PostgreSQL", "Prometheus", "ArgoCD"],
    fields: [
      { name: "serviceName", label: "Service Name", type: "text", required: true },
      { name: "namespace", label: "Namespace", type: "text", required: true },
      { name: "runtime", label: "Runtime", type: "select", options: ["go", "node"], required: true },
      { name: "database", label: "Database", type: "select", options: ["none", "postgresql"], required: false },
    ],
  },
  {
    id: "cronjob",
    name: "CronJob Worker",
    description: "Scheduled batch job with monitoring integration",
    stack: ["Python", "Kubernetes CronJob", "Prometheus"],
    fields: [
      { name: "serviceName", label: "Service Name", type: "text", required: true },
      { name: "namespace", label: "Namespace", type: "text", required: true },
      { name: "schedule", label: "Cron Schedule", type: "text", required: true },
    ],
  },
]
