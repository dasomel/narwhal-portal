import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

// portal#19: listSecrets() used to GET /v1/secret/data/<path> per secret just to
// read Object.keys() off the value, requiring KV data-read capability the
// inventory view has no business holding. These tests pin the fix at the fetch
// boundary — every request listSecrets() makes must be a metadata call, never a
// data call — and cover the explicit-degraded-failure path that replaced the old
// silent `return []` / zero-value-entry fallbacks.
//
// narwhal#156 / portal#54: the cluster stopped injecting a long-lived
// OPENBAO_TOKEN and instead grants OpenBao Kubernetes auth via a projected
// service-account token file. The lower half of this file mocks `fs` (the JWT
// file) and `fetch` (the OpenBao HTTP API) to cover that token provider
// without a real cluster. Because listSecrets() now calls baoFetch(), which
// resolves a token via getOpenBaoToken() on every call, `fs` is mocked
// file-wide (readFileSync defaults to ENOENT below) so the portal#19 tests
// above transparently fall through to the dev-mode empty-token path without
// needing to know about Kubernetes auth at all.
vi.mock("fs", () => ({ readFileSync: vi.fn() }))
vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}))

import { readFileSync } from "fs"
import { cacheGet, cacheSet } from "./valkey"
import { listSecrets, SecretMetadataError, getOpenBaoToken } from "./openbao"

const mockedReadFileSync = vi.mocked(readFileSync)
const mockedCacheGet = vi.mocked(cacheGet)
const mockedCacheSet = vi.mocked(cacheSet)

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
  err.code = "ENOENT"
  return err
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedCacheGet.mockResolvedValue(null)
  mockedCacheSet.mockResolvedValue(undefined)
  // No projected SA token by default -> auth resolves to "token" mode, and
  // with no OPENBAO_TOKEN set outside production that's an empty header,
  // which the listSecrets tests below don't inspect.
  mockedReadFileSync.mockImplementation((path) => {
    throw enoent(String(path))
  })
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

describe("openbao Kubernetes auth token provider", () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const mockFetch = vi.fn()
  let clockStep = 0

  beforeEach(() => {
    process.env = { ...originalEnv, OPENBAO_ADDR: "https://openbao.example.internal" }
    global.fetch = mockFetch
    mockFetch.mockReset()
    mockedReadFileSync.mockImplementation((path) => {
      throw enoent(String(path))
    })

    // Land each test far enough apart in fake time that any token cached by
    // a previous test (max lease_duration*0.8 = 2880s) is unambiguously
    // expired — the in-memory `cachedToken` is module-level state shared
    // across every it() in this file.
    vi.useFakeTimers()
    clockStep += 1
    vi.setSystemTime(new Date(2030, 0, 1).getTime() + clockStep * 10_000_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it("logs in via Kubernetes auth (auth/kubernetes/login) and returns the client token", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValueOnce("jwt-from-file")
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ auth: { client_token: "client-tok-1", lease_duration: 3600, renewable: true } }),
    })

    const token = await getOpenBaoToken()

    expect(token).toBe("client-tok-1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("https://openbao.example.internal/v1/auth/kubernetes/login")
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      role: "narwhal-portal",
      jwt: "jwt-from-file",
    })
  })

  it("reuses the cached client token without logging in again", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValue("jwt-from-file")
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ auth: { client_token: "client-tok-1", lease_duration: 3600, renewable: true } }),
    })

    const first = await getOpenBaoToken()
    const second = await getOpenBaoToken()

    expect(first).toBe("client-tok-1")
    expect(second).toBe("client-tok-1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("collapses concurrent cold-cache callers into a single login", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValue("jwt-from-file")
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ auth: { client_token: "tok-shared", lease_duration: 3600, renewable: true } }),
    })

    const tokens = await Promise.all([getOpenBaoToken(), getOpenBaoToken(), getOpenBaoToken()])

    expect(tokens).toEqual(["tok-shared", "tok-shared", "tok-shared"])
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("treats lease_duration 0 as the default lease instead of expiring the cache immediately", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValue("jwt-from-file")
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ auth: { client_token: "tok-nolease", lease_duration: 0, renewable: false } }),
    })

    await getOpenBaoToken()
    vi.advanceTimersByTime(60_000)
    const again = await getOpenBaoToken()

    expect(again).toBe("tok-nolease")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("keeps serving a valid cached token when the JWT file is transiently unmounted and the method is unset", async () => {
    delete process.env.OPENBAO_AUTH_METHOD
    mockedReadFileSync.mockReturnValue("jwt-from-file")
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ auth: { client_token: "tok-cached", lease_duration: 3600, renewable: true } }),
    })
    await getOpenBaoToken()

    mockedReadFileSync.mockImplementation((path) => {
      throw enoent(String(path))
    })
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.OPENBAO_TOKEN

    await expect(getOpenBaoToken()).resolves.toBe("tok-cached")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("re-logs in once the cached token passes its lease_duration*0.8 expiry", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValue("jwt-from-file")
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: "tok-1", lease_duration: 10, renewable: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: "tok-2", lease_duration: 10, renewable: true } }),
      })

    const first = await getOpenBaoToken()
    expect(first).toBe("tok-1")

    // 80% of a 10s lease is 8s; 9s puts us past expiry.
    vi.advanceTimersByTime(9_000)
    const second = await getOpenBaoToken()

    expect(second).toBe("tok-2")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("retries once via a fresh login after baoFetch receives a 403", async () => {
    process.env.OPENBAO_AUTH_METHOD = "kubernetes"
    mockedReadFileSync.mockReturnValue("jwt-from-file")

    let loginCalls = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/v1/auth/kubernetes/login")) {
        loginCalls += 1
        return {
          ok: true,
          json: async () => ({
            auth: { client_token: `tok-${loginCalls}`, lease_duration: 3600, renewable: true },
          }),
        }
      }
      if (url.includes("/v1/secret/metadata/narwhal-portal/?list=true")) {
        // First attempt (with tok-1) is rejected; only the retry (post force-refresh, tok-2) succeeds.
        if (loginCalls < 2) return { ok: false, status: 403 }
        return { ok: true, json: async () => ({ data: { keys: [] } }) }
      }
      throw new Error(`unexpected fetch to ${url}`)
    })

    const entries = await listSecrets()

    expect(entries).toEqual([])
    expect(loginCalls).toBe(2)
  })

  it("falls back to OPENBAO_TOKEN outside production when no Kubernetes JWT is mounted", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    delete process.env.OPENBAO_AUTH_METHOD
    process.env.OPENBAO_TOKEN = "dev-static-token"
    // readFileSync already throws ENOENT by default (beforeEach), so auth
    // method resolves to "token".

    const token = await getOpenBaoToken()

    expect(token).toBe("dev-static-token")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("uses OPENBAO_TOKEN directly when OPENBAO_AUTH_METHOD=token, without touching Kubernetes auth", async () => {
    process.env.OPENBAO_AUTH_METHOD = "token"
    process.env.OPENBAO_TOKEN = "explicit-static-token"

    const token = await getOpenBaoToken()

    expect(token).toBe("explicit-static-token")
    expect(mockedReadFileSync).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("throws in production when neither Kubernetes auth nor OPENBAO_TOKEN is available", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.OPENBAO_AUTH_METHOD
    delete process.env.OPENBAO_TOKEN
    // readFileSync throws ENOENT by default (beforeEach) -> no Kubernetes JWT.

    await expect(getOpenBaoToken()).rejects.toThrow(/Missing required production configuration/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
