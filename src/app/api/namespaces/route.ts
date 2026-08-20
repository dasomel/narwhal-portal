import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getNamespaces, createNamespace } from "@/lib/k8s-client"
import { getVisibilityScope, namespaceMatchesScope } from "@/lib/role-filter"

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
  const scope = getVisibilityScope(session.groups ?? [], session.teams ?? [])
  const namespaces = await getNamespaces()
  return NextResponse.json(namespaces.filter((ns) => namespaceMatchesScope(ns.name, scope.namespaces)))
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

  // The team label is an ownership claim, and ownership is what every downstream
  // scope check reads. Taking it from the request body unverified let a developer
  // stamp a new namespace as belonging to a team they are not in — and then, via
  // the team mappings, see and act on it as that team. A caller may only claim a
  // team they actually hold; cluster-admin may set any.
  const teams: string[] = session.teams ?? []
  const requested = typeof body.team === "string" ? body.team : null
  if (requested && session.user.role !== "cluster-admin" && !teams.includes(requested)) {
    return NextResponse.json(
      { error: `Cannot create a namespace owned by '${requested}': you are not a member of that team` },
      { status: 403 },
    )
  }
  const team = requested ?? teams[0] ?? session.user.name ?? "unknown"

  const ok = await createNamespace(name, { team })
  if (!ok) return NextResponse.json({ error: "Failed to create namespace" }, { status: 500 })
  return NextResponse.json({ success: true, namespace: name })
}
