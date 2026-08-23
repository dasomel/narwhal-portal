import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getNamespaces } from "@/lib/k8s-client"
import { GiteaError, giteaConfigured, requestTenantNamespace } from "@/lib/gitea"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"
import { resolveNamespaceOwner } from "@/lib/namespace-ownership"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Scope the list to what the caller may see. It previously returned every
  // namespace in the cluster to anyone who was merely authenticated — a viewer or
  // a guest included — which leaks the tenant list: namespace names carry team and
  // project names, and the set of them is a map of who runs what.
  //
  // getNamespaces() is cached under one global key on purpose. The cache holds the
  // UPSTREAM answer and the filter runs per request, so callers never share a
  // filtered result. Caching post-filter would be the bug this shape avoids.
  // Ownership now comes from the namespace's own narwhal.io/team label, with the
  // config patterns still honoured for namespaces that predate the tenant flow —
  // see resolveNamespaceScope. A caller sees a namespace when their team owns it.
  const scope = await getEffectiveScope(session)
  const namespaces = await getNamespaces()
  return NextResponse.json(namespaces.filter((ns) => namespaceVisible(ns.name, scope)))
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  const name = body.name as string
  if (!name || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return NextResponse.json({ error: "Invalid namespace name" }, { status: 400 })
  }
  if (!name.startsWith("dev-")) {
    return NextResponse.json({ error: "Self-service namespaces must start with 'dev-'" }, { status: 400 })
  }

  const teams: string[] = session.teams ?? []
  const requested = typeof body.team === "string" ? body.team : null
  const ownerVerdict = resolveNamespaceOwner(session.user.role, teams, requested)
  if (!ownerVerdict.ok) {
    return NextResponse.json({ error: ownerVerdict.message }, { status: ownerVerdict.status })
  }
  const team = ownerVerdict.team

  // This opens a PULL REQUEST; it does not create the namespace.
  //
  // It used to call the Kubernetes API directly, which never worked in a deployed
  // cluster — the portal's ServiceAccount has `namespaces: [get, list, watch]`, so
  // the call returned 403. That is the right permission set and it stays: a
  // namespace carries an owner, a quota and a group that may deploy into it, and
  // those are a decision, not a form submission. The merge is where the decision
  // gets made, by a person, with a record of who asked.
  if (!giteaConfigured) {
    return NextResponse.json(
      { error: "Namespace requests are unavailable: the portal has no GitOps credentials configured" },
      { status: 503 },
    )
  }

  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "namespace.create.request",
    source: "manual",
    resource: { kind: "Namespace", namespace: name },
    title: `Namespace request started: ${name}`,
    description: `team=${team}`,
  })

  try {
    const result = await requestTenantNamespace({
      namespace: name,
      team,
      requestedBy: session.user.email ?? session.user.name ?? "unknown",
    })
    await completeOperation(
      ctx,
      `Namespace request opened: ${name}`,
      `team=${team}; PR #${result.pullRequestNumber}`,
    )
    return NextResponse.json({
      success: true,
      namespace: name,
      team,
      status: "requested",
      pullRequestUrl: result.pullRequestUrl,
      pullRequestNumber: result.pullRequestNumber,
    })
  } catch (err) {
    if (err instanceof GiteaError) {
      // 409/422 from the contents API means the branch or file is already there —
      // that is a duplicate request, not a server fault, and the caller can act on it.
      const status = err.status === 409 || err.status === 422 ? 409 : 502
      const message =
        status === 409 ? `A request for '${name}' is already open` : `Could not open the namespace request: ${err.message}`
      await failOperation(ctx, `Namespace request failed: ${name}`, message)
      return NextResponse.json({ error: message }, { status })
    }
    console.error("[api/namespaces] request failed", err)
    await failOperation(ctx, `Namespace request failed: ${name}`, err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Could not open the namespace request" }, { status: 502 })
  }
}
