import { beforeEach, describe, expect, it, vi } from "vitest"

const { instances } = vi.hoisted(() => ({ instances: [] as Array<{ url: string; options: Record<string, unknown> }> }))

vi.mock("ioredis", () => ({
  default: class {
    constructor(url: string, options: Record<string, unknown>) {
      instances.push({ url, options })
    }
    async set() { return "OK" }
    async publish() { return 1 }
    on() { return this }
  },
}))

async function loadValkey() {
  vi.resetModules()
  return import("./valkey")
}

describe("Valkey production connection security", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    instances.length = 0
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("VALKEY_URL", "rediss://narwhal-portal-valkey.devtools.svc.cluster.local:6379")
    vi.stubEnv("VALKEY_TLS", "true")
    vi.stubEnv("VALKEY_USERNAME", "portal")
    vi.stubEnv("VALKEY_PASSWORD", "test-secret")
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ssl/narwhal/ca.crt")
  })

  it("rejects the removed production bypass even when secure settings are present", async () => {
    vi.stubEnv("VALKEY_INSECURE_PRODUCTION", "true")
    const { getValkey } = await loadValkey()

    let message = ""
    try {
      getValkey()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/VALKEY_INSECURE_PRODUCTION is no longer supported/)
    expect(message).not.toContain("test-secret")
    expect(instances).toHaveLength(0)
  })

  it.each([
    ["TLS", "VALKEY_TLS", "false"],
    ["password", "VALKEY_PASSWORD", ""],
    ["ACL username", "VALKEY_USERNAME", ""],
    ["TLS URL", "VALKEY_URL", "redis://narwhal-portal-valkey.devtools.svc.cluster.local:6379"],
  ])("rejects missing or insecure %s configuration", async (_label, key, value) => {
    vi.stubEnv(key, value)
    const { getValkey } = await loadValkey()

    expect(() => getValkey()).toThrow()
    expect(instances).toHaveLength(0)
  })

  it("creates authenticated TLS cache and live clients and preserves the mounted CA setting", async () => {
    const { getValkey, getLiveValkey } = await loadValkey()

    await expect(getValkey().set("security-probe", "ok")).resolves.toBe("OK")
    await expect(getLiveValkey().publish("security-probe", "ok")).resolves.toBe(1)

    expect(instances).toHaveLength(2)
    for (const instance of instances) {
      expect(instance.url).toBe("rediss://narwhal-portal-valkey.devtools.svc.cluster.local:6379")
      expect(instance.options).toMatchObject({
        username: "portal",
        password: "test-secret",
        tls: {},
      })
      // toEqual, not toMatchObject: `tls: { rejectUnauthorized: false }` must fail this test
      expect(instance.options.tls).toEqual({})
    }
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/narwhal/ca.crt")
  })

  it("preserves development connections without TLS and credentials", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("VALKEY_URL", "redis://localhost:6379")
    vi.stubEnv("VALKEY_TLS", "false")
    vi.stubEnv("VALKEY_USERNAME", "")
    vi.stubEnv("VALKEY_PASSWORD", "")
    const { getValkey } = await loadValkey()

    expect(() => getValkey()).not.toThrow()
    expect(instances[0].url).toBe("redis://localhost:6379")
    expect(instances[0].options).not.toHaveProperty("tls")
    expect(instances[0].options).not.toHaveProperty("username")
    expect(instances[0].options).not.toHaveProperty("password")
  })
})
