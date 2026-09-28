import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

vi.mock("./config", () => ({ getK8sApiServer: () => "https://k8s.mock", isProduction: () => false }))
vi.mock("./valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn(), cacheDel: vi.fn() }))

describe("Kubernetes credential failures", () => {
  const originalEnv = { ...process.env }
  let dir: string
  let tokenFile: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), "k8s-credential-test-"))
    tokenFile = join(dir, "token")
    process.env = { ...originalEnv, K8S_SA_TOKEN_FILE: tokenFile }
    delete process.env.K8S_TOKEN_AUDIENCE
  })

  afterEach(() => {
    process.env = originalEnv
    rmSync(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it("re-reads a rotated projected file and succeeds after one 401", async () => {
    writeFileSync(tokenFile, "expired-token-sentinel")
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      if (authorization === "Bearer expired-token-sentinel") {
        writeFileSync(tokenFile, "rotated-token-sentinel")
        return new Response(null, { status: 401 })
      }
      return Response.json({ items: [{ metadata: { name: "ok" } }] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { listBounded } = await import("./k8s-client")

    const result = await listBounded("/api/v1/pods")
    expect(result.items).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe("Bearer rotated-token-sentinel")
  })

  it.each([401, 403])("throws a sanitized credential error on %i", async (status) => {
    const sentinel = "secret-token-sentinel-54"
    writeFileSync(tokenFile, sentinel)
    const fetchMock = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal("fetch", fetchMock)
    const { listBounded, K8sCredentialError, K8sHttpError } = await import("./k8s-client")

    const error = await listBounded("/api/v1/pods").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(K8sCredentialError)
    if (!(error instanceof K8sCredentialError)) throw error
    expect(error).toBeInstanceOf(K8sHttpError)
    expect(error.status).toBe(status)
    expect(error.message).toContain("K8S_SA_TOKEN_FILE")
    expect(error.message).toContain(String(status))
    expect(error.message).not.toContain(sentinel)
    expect(JSON.stringify({ name: error.name, message: error.message, status: error.status })).not.toContain(sentinel)
    expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1)
  })
})
