import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  rollbackArgoApp,
} from "@/lib/argocd"
import { assertK8sName, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden: cluster-admin only" }, { status: 403 })
  }

  const { name } = await params
  try {
    assertK8sName(name, "appName")
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }
  const body = await req.json().catch(() => ({}))
  const idRaw = (body as { id?: unknown }).id
  if (typeof idRaw !== "number" || !Number.isInteger(idRaw) || idRaw < 0) {
    return NextResponse.json(
      { error: "ValidationError", message: "id must be a non-negative integer", field: "id" },
      { status: 400 },
    )
  }

  try {
    await assertAppAccessible(name, {
      role: session.user.role,
      groups: session.groups,
    })
    const ok = await rollbackArgoApp(name, idRaw)
    if (!ok) return NextResponse.json({ error: "Rollback failed" }, { status: 500 })
    console.info("[audit] argocd-rollback", {
      actor: session.user.email ?? session.user.name ?? "unknown",
      role: session.user.role,
      app: name,
      historyId: idRaw,
      at: new Date().toISOString(),
    })
    return NextResponse.json({ success: true, message: `Rollback triggered for ${name} to #${idRaw}` })
  } catch (err) {
    if (err instanceof ArgoNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof ArgoForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    const message = err instanceof Error ? err.message : "Rollback failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
