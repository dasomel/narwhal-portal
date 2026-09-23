import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

vi.mock("./valkey", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

import { cacheGet, cacheSet, cacheDel } from "./valkey"
import { getRoutes, toggleRoute, ApisixCredentialError } from "./apisix-client"

describe("apisix-client credential handling", () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch
  const mockFetch = vi.fn()

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.APISIX_ADMIN_URL = "http://apisix-admin.local:9180"
    global.fetch = mockFetch
    mockFetch.mockReset()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(cacheSet).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    process.env = originalEnv
    global.fetch = originalFetch
  })

  it("uses APISIX_API_KEY_READONLY for reads when configured", async () => {
    process.env.APISIX_API_KEY = "admin-key"
    process.env.APISIX_API_KEY_READONLY = "readonly-key"
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ list: [] }) })

    await getRoutes()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/apisix/admin/routes"),
      expect.objectContaining({ headers: { "X-API-KEY": "readonly-key" } })
    )
  })

  it("falls back to the admin key for reads in non-production when readonly key is unset", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.APISIX_API_KEY = "admin-key"
    delete process.env.APISIX_API_KEY_READONLY
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ list: [] }) })

    await getRoutes()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/apisix/admin/routes"),
      expect.objectContaining({ headers: { "X-API-KEY": "admin-key" } })
    )
  })

  it("throws ApisixCredentialError in production when APISIX_API_KEY_READONLY is unset, without calling fetch", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.APISIX_API_KEY = "admin-key"
    delete process.env.APISIX_API_KEY_READONLY

    await expect(getRoutes()).rejects.toBeInstanceOf(ApisixCredentialError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("does not mask a credential error as an empty route list", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.APISIX_API_KEY_READONLY
    delete process.env.APISIX_API_KEY

    await expect(getRoutes()).rejects.toBeInstanceOf(ApisixCredentialError)
  })

  it("returns an empty list (not throwing) on a genuine connection failure", async () => {
    process.env.APISIX_API_KEY = "admin-key"
    process.env.APISIX_API_KEY_READONLY = "readonly-key"
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"))

    const routes = await getRoutes()

    expect(routes).toEqual([])
  })

  it("throws ApisixCredentialError in production when APISIX_API_KEY is unset for a write (toggleRoute)", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.APISIX_API_KEY

    await expect(toggleRoute("route-1", true)).rejects.toBeInstanceOf(ApisixCredentialError)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("toggleRoute uses the admin key and invalidates the routes cache", async () => {
    process.env.APISIX_API_KEY = "admin-key"
    mockFetch.mockResolvedValueOnce({ ok: true })

    await toggleRoute("route-1", true)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/apisix/admin/routes/route-1"),
      expect.objectContaining({
        method: "PATCH",
        headers: { "X-API-KEY": "admin-key", "Content-Type": "application/json" },
        body: JSON.stringify({ status: 1 }),
      })
    )
    expect(cacheDel).toHaveBeenCalledWith("apisix:routes")
  })
})
