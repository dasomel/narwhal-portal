import { cacheDel, cacheGet, cacheSet } from "./valkey"
import { getDependencyUrl, isProduction } from "./config"

function apisixUrl(): string {
  return getDependencyUrl("APISIX_ADMIN_URL", "http://localhost:9180")
}

// Portal #54: distinguishes "the admin credential itself is missing/misconfigured"
// from "APISIX is unreachable" so callers don't mistake a credential gap for a
// provider outage (mirrors KeycloakCredentialError/KeycloakUnavailableError).
export class ApisixCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApisixCredentialError"
  }
}

// D05 least-privilege split: full admin key for writes (toggle), viewer key for reads (list).
// Read at call-time (not module-level consts) — mirrors getDependencyUrl's contract
// in config.ts so credential rotation via a re-mounted env/secret takes effect on
// the next call without a process restart.
function apisixAdminKey(): string {
  const key = process.env.APISIX_API_KEY
  if (key) return key
  if (!isProduction()) return ""
  throw new ApisixCredentialError(
    "APISIX_API_KEY is not configured. Set APISIX_API_KEY to the admin-scoped API key."
  )
}

// Portal #54: previously silently fell back to the admin key whenever the
// scoped readonly key was unset, so a missing READONLY_KEY was invisible and
// reads quietly ran with full write privilege. Production now fails closed
// instead; only non-production keeps the admin-key fallback as a dev
// convenience for a single-key local APISIX (mirrors KEYCLOAK_ADMIN_TOKEN /
// OPENBAO_TOKEN dev-only fallbacks in keycloak-client.ts / openbao.ts).
function apisixReadonlyKey(): string {
  const key = process.env.APISIX_API_KEY_READONLY
  if (key) return key
  if (!isProduction()) return apisixAdminKey()
  throw new ApisixCredentialError(
    "APISIX_API_KEY_READONLY is not configured. Set APISIX_API_KEY_READONLY to a read-only scoped API key."
  )
}

interface ApisixRoute {
  id: string
  name?: string
  uri?: string
  uris?: string[]
  status: number
  plugins?: Record<string, unknown>
}

export async function getRoutes(): Promise<ApisixRoute[]> {
  const cached = await cacheGet<ApisixRoute[]>("apisix:routes")
  if (cached) return cached

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${apisixUrl()}/apisix/admin/routes`, {
      headers: { "X-API-KEY": apisixReadonlyKey() },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`APISIX routes ${res.status}`)
    const data = await res.json()
    const routes: ApisixRoute[] = (data.list ?? []).map((item: { value: ApisixRoute }) => item.value)
    await cacheSet("apisix:routes", routes, 30)
    return routes
  } catch (err) {
    // Portal #54: a credential-configuration error is not "provider unreachable" —
    // let it propagate instead of masking it as an empty route list.
    if (err instanceof ApisixCredentialError) throw err
    console.warn("[apisix] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}

export async function toggleRoute(id: string, enable: boolean): Promise<void> {
  const res = await fetch(`${apisixUrl()}/apisix/admin/routes/${id}`, {
    method: "PATCH",
    headers: { "X-API-KEY": apisixAdminKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ status: enable ? 1 : 0 }),
  })
  if (!res.ok) throw new Error(`Toggle route failed: ${res.status}`)
  await cacheDel("apisix:routes")
}
