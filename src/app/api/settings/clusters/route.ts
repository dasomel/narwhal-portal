import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"
import {
  listClusters,
  registerCluster,
  removeCluster,
  resolveClusterCredentials,
} from "@/lib/cluster-registry"
import type { Cluster, ClusterRegistrationInput } from "@/types/cluster"

export const dynamic = "force-dynamic"

/**
 * portal#21 CRUD surface for the cluster registry. Gated cluster-admin-only for
 * every method — unlike most read routes, even GET here reveals which env vars
 * back each cluster's credentials (names only, never values; see
 * ClusterCredentialRef), which is not information a developer/viewer role
 * should see, mirroring src/app/api/settings/groups/route.ts's admin-only gate.
 */
export interface ClusterListItem extends Cluster {
  /** Whether resolveClusterCredentials() finds a live value at the referenced env vars — never the value itself. */
  credentialsConfigured: boolean
}

export interface ClusterListResponse {
  clusters: ClusterListItem[]
}

function toListItem(cluster: Cluster): ClusterListItem {
  return { ...cluster, credentialsConfigured: resolveClusterCredentials(cluster) !== null }
}

function adminGateResponse(result: { error: "unauthorized" | "forbidden" }) {
  const status = result.error === "unauthorized" ? 401 : 403
  return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
}

export async function GET() {
  const result = await requireAdmin()
  if ("error" in result) return adminGateResponse(result)
  try {
    const clusters = await listClusters()
    const body: ClusterListResponse = { clusters: clusters.map(toListItem) }
    return NextResponse.json(body)
  } catch (err) {
    console.error("GET /api/settings/clusters error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const result = await requireAdmin()
  if ("error" in result) return adminGateResponse(result)
  try {
    const body = (await req.json().catch(() => null)) as ClusterRegistrationInput | null
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "ValidationError", message: "request body is required", field: "body" }, { status: 400 })
    }
    const cluster = await registerCluster(body)
    return NextResponse.json(toListItem(cluster), { status: 201 })
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    console.error("POST /api/settings/clusters error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const result = await requireAdmin()
  if ("error" in result) return adminGateResponse(result)
  try {
    const id = req.nextUrl.searchParams.get("id")
    if (!id) {
      return NextResponse.json({ error: "ValidationError", message: "id query param is required", field: "id" }, { status: 400 })
    }
    const verdict = await removeCluster(id)
    if (!verdict.ok) {
      return NextResponse.json({ error: "ValidationError", message: verdict.message, field: "id" }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("DELETE /api/settings/clusters error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
