import { namespaceVisible, type EffectiveScope } from "./scope"
import type { UserRole } from "./auth"
import type { LiveEvent } from "@/types/live"

/**
 * portal#12: authorization runs on the structured `resource`/`visibility` envelope
 * fields only — no more parsing a namespace out of `title`/`description`. Every
 * producer (K8s informer, operation-context, /api/events/ingest) now sets one of
 * `resource.namespace` or an explicit `visibility`, so this is exhaustive: a
 * namespaced event is scoped like anything else in `scope`; a namespace-less one
 * is visible only when `visibility: "cluster"` is explicitly set (still subject to
 * the viewer/guest node/secret filters below) — "system", any other value, or an
 * absent `visibility` default-denies for everyone but cluster-admin, rather than
 * falling through to "unfiltered" the way the old title/description regex did.
 *
 * Used by both the SSE live path and the replay path in
 * src/app/api/events/stream/route.ts so the two apply identical authorization.
 */
export function isEventFiltered(event: LiveEvent, role: UserRole, scope: EffectiveScope): boolean {
  if (role === "cluster-admin") return false

  if (role === "viewer" || role === "guest") {
    if (event.type === "node") return true
    if (/secret/i.test(event.description)) return true
  }

  const ns = event.resource?.namespace ?? null
  if (ns) {
    if (!scope.hasMapping) return true
    return !namespaceVisible(ns, scope)
  }

  if (event.visibility === "cluster") return false
  // "system", any other/unrecognized value, or absent — default-deny.
  return true
}
