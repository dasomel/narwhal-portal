import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import {
  assertAppAccessible,
  ArgoForbiddenError,
  ArgoNotFoundError,
  syncArgoApp,
} from "@/lib/argocd"
import { cacheDel } from "@/lib/valkey"
import { assertK8sName, ValidationError } from "@/lib/validation"
import type { ArgoCDSyncRequest, ArgoCDSyncResponse } from "@/types/api"

export const dynamic = "force-dynamic"

const ALLOWED_ROLES = new Set(["cluster-admin", "developer"])

export async function POST(
  req: NextRequest,
): Promise<NextResponse<ArgoCDSyncResponse>> {
  const session = await auth()
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }
  if (!ALLOWED_ROLES.has(session.user.role ?? "")) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 })
  }

  let body: Partial<ArgoCDSyncRequest>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { appName } = body
  if (!appName || typeof appName !== "string" || appName.trim() === "") {
    return NextResponse.json({ ok: false, error: "appName is required" }, { status: 400 })
  }
  const trimmed = appName.trim()
  try {
    assertK8sName(trimmed, "appName")
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 })
    }
    throw err
  }

  try {
    // H-3: project-scope check.
    await assertAppAccessible(trimmed, {
      role: session.user.role,
      groups: session.groups,
    })
    const result = await syncArgoApp(trimmed)
    console.info("[audit] argocd-sync", {
      actor: session.user.email ?? session.user.name ?? "unknown",
      role: session.user.role,
      app: trimmed,
      at: new Date().toISOString(),
    })

    // Invalidate app-list cache so next GET fetches fresh state
    try {
      await cacheDel("argocd:apps")
      await cacheDel(`argocd:app:${trimmed}`)
    } catch {
      // cache invalidation failure is non-fatal
    }

    return NextResponse.json({ ok: true, app: result })
  } catch (err) {
    if (err instanceof ArgoNotFoundError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 404 })
    }
    if (err instanceof ArgoForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 })
    }
    const message = err instanceof Error ? err.message : "ArgoCD sync failed"
    console.error("[api/argocd/sync]", message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
