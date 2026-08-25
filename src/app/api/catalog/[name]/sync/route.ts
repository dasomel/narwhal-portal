import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  syncArgoApp,
} from "@/lib/argocd"
import { assertK8sName, ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
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

  try {
    // H-3: project-scope check.
    const app = await assertAppAccessible(name, {
      role: session.user.role,
      groups: session.groups,
      teams: session.teams,
    })
    const ctx = await beginOperation({
      request: req,
      session,
      operationType: "catalog.sync",
      source: "argocd",
      resource: {
        kind: "Application",
        namespace: app.spec.destination?.namespace,
        name,
      },
      title: `Catalog sync started: ${name}`,
    })

    let result
    try {
      result = await syncArgoApp(name)
    } catch (err) {
      await failOperation(
        ctx,
        `Catalog sync failed: ${name}`,
        err instanceof Error ? err.message : String(err),
      )
      throw err
    }

    await completeOperation(
      ctx,
      `Catalog sync completed: ${name}`,
      `Synced to revision ${result.revision ?? "unknown"}`,
    )

    return NextResponse.json({ success: true, message: `Sync triggered for ${name}`, app: result })
  } catch (err) {
    if (err instanceof ArgoNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    if (err instanceof ArgoForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    const message = err instanceof Error ? err.message : "Sync failed"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
