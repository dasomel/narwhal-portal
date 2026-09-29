import { NextResponse } from "next/server"
import { auth, requireRole } from "@/lib/auth"
import { TEMPLATES, type ServiceTemplate } from "@/lib/service-templates"
import { validateProvisioningRequest } from "@/lib/domain/service-template-provisioning"

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

  const { session } = gate
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = undefined
  }
  const validation = validateProvisioningRequest(body, { sessionTeams: session.teams ?? [] })
  if (!validation.valid) {
    return NextResponse.json(
      { error: { code: validation.error.code, message: validation.error.message } },
      { status: validation.status },
    )
  }
  if (validation.request.mode !== "preview") {
    return NextResponse.json(
      { error: { code: "INVALID_MODE", message: "Only preview requests are supported" } },
      { status: 400 },
    )
  }
  const { templateId, values } = validation.request
  // In production: create Gitea repo + ArgoCD app + namespace
  // For now, return a preview of what would be created
  return NextResponse.json({
    success: true,
    preview: {
      templateId,
      values,
      willCreate: [
        `Gitea repository: ${values.serviceName ?? "unknown"}`,
        `ArgoCD application: ${values.serviceName ?? "unknown"}`,
        `Namespace: ${values.namespace ?? "default"}`,
      ],
    },
  })
}
