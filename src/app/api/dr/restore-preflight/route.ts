import { randomUUID } from "crypto"
import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import {
  aggregateRestorePreflight,
  REQUIRED_RESTORE_PREFLIGHT_CHECKS,
  resolveRestoreTenantScope,
  type RestorePreflightCheck,
} from "@/lib/domain/restore"
import { getNamespacesForScope } from "@/lib/k8s-client"
import { TEAM_LABEL } from "@/lib/role-filter"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

const NAMESPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export async function POST(req: Request) {
  const gate = await requireRole("cluster-admin", "developer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  let body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    ![body.cluster_id, body.backup_id].every((id) => typeof id === "string" && id.length <= 253 && /^\S+$/.test(id)) ||
    ![body.source_namespace, body.target_namespace].every((ns) => typeof ns === "string" && NAMESPACE_NAME.test(ns))
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // D2: scope currently resolves only the default cluster; deny mismatches until
  // cluster-aware adapters exist, at the cost of rejecting other registered ids.
  if (body.cluster_id !== DEFAULT_CLUSTER_ID) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let namespaces
  try {
    const scope = await getEffectiveScope(gate.session, DEFAULT_CLUSTER_ID)
    if (!namespaceVisible(body.source_namespace, scope) || !namespaceVisible(body.target_namespace, scope)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    namespaces = await getNamespacesForScope(scope)
  } catch (error) {
    console.error("Restore preflight cluster lookup failed", error)
    return NextResponse.json({ error: "Cluster unavailable" }, { status: 503 })
  }
  const ownerTeam = namespaces.find((ns) => ns.name === body.target_namespace)?.labels[TEAM_LABEL]
  // D1: use the target's owner label, never caller claims or a provisioning default.
  // Unlabelled targets are denied; completing label migration is the escape hatch.
  const tenantScope = resolveRestoreTenantScope(ownerTeam ? {
    namespace: body.target_namespace,
    ownerTeam,
  } : null)
  if (!tenantScope) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // D3: no backend adapters exist, so server-observed checks stay empty and
  // verdict stays needs-evidence with all nine ids missing. Adapters replace
  // this empty list; caller checks are ignored to prevent forged readiness.
  const checks: RestorePreflightCheck[] = []
  const suppliedIds = new Set(checks.map((check) => check.checkId))
  return NextResponse.json({
    verdict: aggregateRestorePreflight(REQUIRED_RESTORE_PREFLIGHT_CHECKS, checks),
    tenant_scope: { namespace: tenantScope.namespace, owner_team: tenantScope.ownerTeam },
    cluster_id: DEFAULT_CLUSTER_ID,
    missing_check_ids: REQUIRED_RESTORE_PREFLIGHT_CHECKS.filter((id) => !suppliedIds.has(id)),
    correlation_id: randomUUID(),
  })
}
