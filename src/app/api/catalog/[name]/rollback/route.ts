import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  getArgoAppFresh,
  getOperationOutcome,
  rollbackArgoApp,
} from "@/lib/argocd"
import { assertK8sName, ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

export const dynamic = "force-dynamic"

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const gate = await requireRole("cluster-admin")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden: cluster-admin only" },
      { status: gate.error === "unauthorized" ? 401 : 403 }
    )
  }
  const { session } = gate

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

    // portal#59: rollbackArgoApp only tells us ArgoCD accepted the rollback
    // request (HTTP 2xx), not that reconciliation to the target revision
    // finished. Re-read the app and check operationState.phase before
    // claiming verified success.
    const fresh = await getArgoAppFresh(name)
    const outcome = fresh === null ? "pending" : getOperationOutcome(fresh)
    if (outcome === "failed") {
      const message = `rollback failed; operationState.phase=${fresh?.status.operationState?.phase ?? "unknown"}`
      await failOperation(ctx, `Catalog rollback failed: ${name}`, message)
      return NextResponse.json({ success: false, message }, { status: 502 })
    }
    if (outcome === "pending") {
      await completeOperation(
        ctx,
        `Catalog rollback triggered (pending convergence): ${name}`,
        `rollback accepted; operationState.phase=${fresh?.status.operationState?.phase ?? "unknown"}`,
      )
      return NextResponse.json({
        success: true,
        pending: true,
        message: `Rollback triggered for ${name} to #${idRaw}; awaiting convergence`,
      })
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
