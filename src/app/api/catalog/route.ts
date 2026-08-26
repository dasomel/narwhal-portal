import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps, appToCatalogService } from "@/lib/argocd"
import { appVisible, getEffectiveScope } from "@/lib/scope"
import { findOwnershipMismatch, getTeamMappings } from "@/lib/role-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The service catalog is a directory of everything deployed, and it was returned
  // in full to anyone with a session. /api/my-apps already scoped the same
  // underlying getArgoApps() result, so the catalog was the way around it: the two
  // routes answered the same question and only one of them asked who was asking.
  //
  // Same predicate as my-apps now, from role-filter.ts, so they cannot drift again.
  const scope = await getEffectiveScope(session)

  try {
    const apps = await getArgoApps()
    const teamMappings = getTeamMappings()
    const services = apps
      .filter((a) =>
        appVisible(
          a.spec.project ?? "default",
          a.spec.destination?.namespace ?? a.metadata.namespace ?? "default",
          scope,
        ),
      )
      .map(appToCatalogService)
      // portal#31 AC: flag (not deny) apps whose declared project and actual
      // destination namespace belong to different teams per role-filter.json —
      // visibility above still uses appVisible's OR semantics unchanged.
      .map((service) => ({
        ...service,
        ownershipMismatch: findOwnershipMismatch(service.project, service.namespace, teamMappings),
      }))
    return NextResponse.json(services)
  } catch (err) {
    console.error("[api/catalog]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
