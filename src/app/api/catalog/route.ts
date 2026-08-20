import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getArgoApps, appToCatalogService } from "@/lib/argocd"
import { appMatchesScope, getVisibilityScope } from "@/lib/role-filter"

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
  const scope = getVisibilityScope(session.groups ?? [], session.teams ?? [])

  try {
    const apps = await getArgoApps()
    const services = apps
      .filter((a) =>
        appMatchesScope(
          a.spec.project ?? "default",
          a.spec.destination?.namespace ?? a.metadata.namespace ?? "default",
          scope,
        ),
      )
      .map(appToCatalogService)
    return NextResponse.json(services)
  } catch (err) {
    console.error("[api/catalog]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
