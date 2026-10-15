import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", () => ({ readFileSync: vi.fn(() => { throw new Error("missing projected JWT") }) }))
vi.mock("./valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
const originalEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...originalEnv, NODE_ENV: "production", OPENBAO_AUTH_METHOD: "token", OPENBAO_TOKEN: "credential-test-only" }
  delete process.env.NEXT_PHASE
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
})
afterEach(() => {
  process.env = originalEnv
  vi.unstubAllGlobals()
})

describe("OpenBao production TLS on every request", () => {
  it("rejects repeated HTTP requests before sending any credential", async () => {
    process.env.OPENBAO_ADDR = "http://openbao.test"
    const { baoFetch } = await import("./openbao")
    await expect(baoFetch("/v1/sys/health")).rejects.toThrow(/HTTPS|https/)
    await expect(baoFetch("/v1/sys/health")).rejects.toThrow(/HTTPS|https/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("revalidates a changed URL after a successful HTTPS request", async () => {
    process.env.OPENBAO_ADDR = "https://openbao.test"
    const { baoFetch } = await import("./openbao")
    await baoFetch("/v1/sys/health")
    process.env.OPENBAO_ADDR = "http://openbao.test"
    await expect(baoFetch("/v1/sys/health")).rejects.toThrow(/HTTPS|https/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(["ftp://openbao.test", "//openbao.test"])("rejects non-HTTPS scheme %s", async (addr) => {
    process.env.OPENBAO_ADDR = addr
    const { baoFetch } = await import("./openbao")
    await expect(baoFetch("/v1/sys/health")).rejects.toThrow(/HTTPS|https/)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("does not expose URL credentials or query tokens in TLS diagnostics", async () => {
    process.env.OPENBAO_ADDR = "http://private-user:private-password@openbao.test?token=private-query"
    const { baoFetch } = await import("./openbao")
    const error = await baoFetch("/v1/sys/health").catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain("private")
  })
})
