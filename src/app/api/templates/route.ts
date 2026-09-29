import { NextResponse } from "next/server"
import { auth, requireRole } from "@/lib/auth"
import { TEMPLATES, type ServiceTemplate } from "@/lib/service-templates"

export const dynamic = "force-dynamic"

export type { ServiceTemplate }

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(TEMPLATES)
}

export async function POST(req: Request) {
  const gate = await requireRole("cluster-admin", "developer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
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
