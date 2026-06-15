import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"

export const dynamic = "force-dynamic"

export interface ServiceTemplate {
  id: string
  name: string
  description: string
  stack: string[]
  fields: Array<{ name: string; label: string; type: "text" | "select"; options?: string[]; required: boolean }>
}

const TEMPLATES: ServiceTemplate[] = [
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

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(TEMPLATES)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  // In production: create Gitea repo + ArgoCD app + namespace
  // For now, return a preview of what would be created
  return NextResponse.json({
    success: true,
    preview: {
      templateId: body.templateId,
      values: body.values,
      willCreate: [
        `Gitea repository: ${body.values?.serviceName ?? "unknown"}`,
        `ArgoCD application: ${body.values?.serviceName ?? "unknown"}`,
        `Namespace: ${body.values?.namespace ?? "default"}`,
      ],
    },
  })
}
