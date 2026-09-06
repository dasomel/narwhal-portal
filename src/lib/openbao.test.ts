import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

// portal#19: listSecrets() used to GET /v1/secret/data/<path> per secret just to
// read Object.keys() off the value, requiring KV data-read capability the
// inventory view has no business holding. These tests pin the fix at the fetch
// boundary — every request listSecrets() makes must be a metadata call, never a
// data call — and cover the explicit-degraded-failure path that replaced the old
// silent `return []` / zero-value-entry fallbacks.
vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))

const { cacheGet, cacheSet } = await import("./valkey")
const { listSecrets, SecretMetadataError } = await import("./openbao")

const mockedCacheGet = vi.mocked(cacheGet)
const mockedCacheSet = vi.mocked(cacheSet)

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedCacheGet.mockResolvedValue(null)
  mockedCacheSet.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("listSecrets — metadata-only inventory", () => {
  it("never requests a /data/ URL, only /metadata/ list + per-secret metadata", async () => {
    const requestedUrls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrls.push(url)
        if (url.includes("?list=true")) {
          return Promise.resolve(jsonResponse({ data: { keys: ["keycloak-token", "gitea-pat"] } }))
        }
        return Promise.resolve(
          jsonResponse({
            data: { current_version: 2, created_time: "2026-01-01T00:00:00Z", updated_time: "2026-02-01T00:00:00Z" },
          }),
        )
      }),
    )

    const entries = await listSecrets()

    expect(requestedUrls.length).toBeGreaterThan(0)
    expect(requestedUrls.some((u) => u.includes("/v1/secret/data/"))).toBe(false)
    expect(requestedUrls.every((u) => u.includes("/v1/secret/metadata/"))).toBe(true)
    expect(entries).toEqual([
      { path: "keycloak-token", version: 2, createdTime: "2026-01-01T00:00:00Z", updatedTime: "2026-02-01T00:00:00Z" },
      { path: "gitea-pat", version: 2, createdTime: "2026-01-01T00:00:00Z", updatedTime: "2026-02-01T00:00:00Z" },
    ])
    // No key names on the response — KV v2 metadata doesn't expose field names,
    // so the shape must not carry a `keys` property at all.
    expect(entries[0]).not.toHaveProperty("keys")
  })

  it("caches only the metadata-derived entries, never re-lists on a cache hit", async () => {
    const cached = [{ path: "cached", version: 1, createdTime: "t", updatedTime: "t" }]
    mockedCacheGet.mockResolvedValue(cached)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const entries = await listSecrets()

    expect(entries).toBe(cached)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns an empty inventory (and caches it) when the prefix genuinely has nothing under it (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(null, 404)))

    const entries = await listSecrets()

    expect(entries).toEqual([])
    expect(mockedCacheSet).toHaveBeenCalledWith(expect.any(String), [], 30)
  })
})

describe("listSecrets — explicit degraded failure", () => {
  it("throws SecretMetadataError instead of silently returning [] when the list call is forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ errors: ["permission denied"] }, 403)))

    await expect(listSecrets()).rejects.toBeInstanceOf(SecretMetadataError)
    // A degraded read must never be cached as if it were a real (empty) inventory.
    expect(mockedCacheSet).not.toHaveBeenCalled()
  })

  it("throws SecretMetadataError instead of silently zero-filling when one secret's metadata read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("?list=true")) {
          return Promise.resolve(jsonResponse({ data: { keys: ["keycloak-token"] } }))
        }
        return Promise.resolve(jsonResponse({ errors: ["permission denied"] }, 403))
      }),
    )

    await expect(listSecrets()).rejects.toBeInstanceOf(SecretMetadataError)
    expect(mockedCacheSet).not.toHaveBeenCalled()
  })
})
