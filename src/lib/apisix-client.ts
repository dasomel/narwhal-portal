import { cacheDel, cacheGet, cacheSet } from "./valkey"

const APISIX_URL = process.env.APISIX_ADMIN_URL ?? "http://localhost:9180"
// D05 least-privilege split: full admin key for writes (toggle), viewer key for reads (list).
// READONLY falls back to the admin key so reads still work before the scoped key is deployed.
const API_KEY = process.env.APISIX_API_KEY ?? ""
const READONLY_KEY = process.env.APISIX_API_KEY_READONLY ?? API_KEY

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
    const res = await fetch(`${APISIX_URL}/apisix/admin/routes`, {
      headers: { "X-API-KEY": READONLY_KEY },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`APISIX routes ${res.status}`)
    const data = await res.json()
    const routes: ApisixRoute[] = (data.list ?? []).map((item: { value: ApisixRoute }) => item.value)
    await cacheSet("apisix:routes", routes, 30)
    return routes
  } catch (err) {
    console.warn("[apisix] Connection failed, returning empty:", (err as Error).message)
    return []
  }
}

export async function toggleRoute(id: string, enable: boolean): Promise<void> {
  const res = await fetch(`${APISIX_URL}/apisix/admin/routes/${id}`, {
    method: "PATCH",
    headers: { "X-API-KEY": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ status: enable ? 1 : 0 }),
  })
  if (!res.ok) throw new Error(`Toggle route failed: ${res.status}`)
  await cacheDel("apisix:routes")
}
