import { fetchWithPolicy, readJsonWithPolicy } from "./http-client"

const PAGE_SIZE = 100
const MAX_PAGES = 100

export interface ResyncEvent {
  metadata?: { uid?: string; resourceVersion?: string }
  reason?: string
  message?: string
  type?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

/** D3: Resume only after a complete bounded snapshot; cost is at most 10k
 * retained events. Larger inventories fail visibly and retry, never advance
 * past omitted events. A dedicated durable controller can replace this adapter. */
export async function listEventsForResync(
  apiServer: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ resourceVersion: string; items: ResyncEvent[] }> {
  const items: ResyncEvent[] = []
  const cursors = new Set<string>()
  let cursor = ""
  let resourceVersion = ""
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor) query.set("continue", cursor)
    const response = await fetchWithPolicy(`${apiServer}/api/v1/events?${query}`, { headers }, {
      signal, retry: false, timeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024,
    })
    if (!response.ok) throw new Error(`resync events ${response.status}`)
    const body = await readJsonWithPolicy<{ metadata?: { resourceVersion?: string; continue?: string }; items?: ResyncEvent[] }>(response)
    if (!Array.isArray(body.items) || body.items.length > PAGE_SIZE || !body.metadata?.resourceVersion) {
      throw new Error("resync events invalid bounded list")
    }
    if (resourceVersion && resourceVersion !== body.metadata.resourceVersion) {
      throw new Error("resync events snapshot changed")
    }
    resourceVersion = body.metadata.resourceVersion
    items.push(...body.items)
    cursor = body.metadata.continue ?? ""
    if (!cursor) return { resourceVersion, items }
    if (cursors.has(cursor)) throw new Error("resync events repeated cursor")
    cursors.add(cursor)
  }
  throw new Error("resync events page limit exceeded")
}
