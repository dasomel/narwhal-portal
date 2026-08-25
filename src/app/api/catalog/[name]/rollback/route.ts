import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  rollbackArgoApp,
} from "@/lib/argocd"
import { assertK8sName, ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

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
    const app = await assertAppAccessible(name, {
      role: session.user.role,
      groups: session.groups,
      teams: session.teams,
    })
    const ctx = await beginOperation({
      request: req,
      session,
      operationType: "catalog.rollback",
      source: "argocd",
      resource: {
        kind: "Application",
        namespace: app.spec.destination?.namespace,
        name,
      },
      title: `Catalog rollback started: ${name} to #${idRaw}`,
    })

    let ok = false
    try {
      ok = await rollbackArgoApp(name, idRaw)
    } catch (err) {
      await failOperation(
        ctx,
        `Catalog rollback failed: ${name}`,
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }

    if (!ok) {
      await failOperation(
        ctx,
        `Catalog rollback failed: ${name}`,
        `Rollback to #${idRaw} returned false`,
      )
      return NextResponse.json({ error: "Rollback failed" }, { status: 500 })
    }

    await completeOperation(
      ctx,
      `Catalog rollback completed: ${name}`,
      `Rolled back ${name} to revision #${idRaw}`,
    )

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
