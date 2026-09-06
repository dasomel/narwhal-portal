import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Portal #20 — projected short-lived K8s SA token provider. Each test imports
// the module fresh (vi.resetModules) so the internal in-memory cache never
// leaks between cases; module-level env snapshotting matches config.test.ts.
const originalEnv = { ...process.env }

/** Builds an unsigned JWT — getK8sBearerToken only decodes the payload for the aud check, it never verifies a signature. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("k8s-token", () => {
  let dir: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    dir = mkdtempSync(join(tmpdir(), "k8s-token-test-"))
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("reads the token from the projected token file", async () => {
    const file = join(dir, "token")
    const token = fakeJwt({ aud: "https://kubernetes.default.svc" })
    writeFileSync(file, token)
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(getK8sBearerToken()).toBe(readFileSync(file, "utf8").trim())
  })

  it("refreshes after the file changes once invalidated (the 401 retry path)", async () => {
    const file = join(dir, "token")
    writeFileSync(file, fakeJwt({ aud: "https://kubernetes.default.svc", v: 1 }))
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file

    const { getK8sBearerToken, invalidateK8sBearerToken } = await import("./k8s-token")
    const first = getK8sBearerToken()

    const rotated = fakeJwt({ aud: "https://kubernetes.default.svc", v: 2 })
    writeFileSync(file, rotated)
    expect(getK8sBearerToken()).toBe(first) // still cached, file changed underneath

    invalidateK8sBearerToken()
    expect(getK8sBearerToken()).toBe(rotated)
  })

  it("re-reads the file automatically once the refresh interval elapses, without invalidation", async () => {
    const file = join(dir, "token")
    writeFileSync(file, fakeJwt({ aud: "https://kubernetes.default.svc", v: 1 }))
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file

    const { getK8sBearerToken } = await import("./k8s-token")
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const first = getK8sBearerToken()

    const rotated = fakeJwt({ aud: "https://kubernetes.default.svc", v: 2 })
    writeFileSync(file, rotated)
    nowSpy.mockReturnValue(1_000_000 + 30_000) // within the interval — still cached
    expect(getK8sBearerToken()).toBe(first)

    nowSpy.mockReturnValue(1_000_000 + 61_000) // past the interval — transparent rotation
    expect(getK8sBearerToken()).toBe(rotated)
  })

  it("falls back to K8S_SA_TOKEN outside production when no token file exists", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = join(dir, "does-not-exist")
    process.env.K8S_SA_TOKEN = "dev-static-token"

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(getK8sBearerToken()).toBe("dev-static-token")
  })

  it("throws in production when no token file exists, instead of using K8S_SA_TOKEN", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.K8S_SA_TOKEN_FILE = join(dir, "does-not-exist")
    process.env.K8S_SA_TOKEN = "should-never-be-used-in-prod"

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(() => getK8sBearerToken()).toThrow(/Missing required production configuration/)
  })

  it("accepts any audience when K8S_TOKEN_AUDIENCE is not configured (kubeadm default varies by issuer)", async () => {
    const file = join(dir, "token")
    // A real kubeadm cluster's default projected-token audience is commonly the
    // issuer URL (https://kubernetes.default.svc.cluster.local), not the bare
    // https://kubernetes.default.svc some docs assume — with no configured
    // expectation, this must not be rejected.
    writeFileSync(file, fakeJwt({ aud: "https://kubernetes.default.svc.cluster.local" }))
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file
    delete process.env.K8S_TOKEN_AUDIENCE

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(getK8sBearerToken()).toBe(readFileSync(file, "utf8").trim())
  })

  it("rejects a token whose audience does not match K8S_TOKEN_AUDIENCE once it is explicitly configured", async () => {
    const file = join(dir, "token")
    writeFileSync(file, fakeJwt({ aud: "https://some-other-cluster.example" }))
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file
    process.env.K8S_TOKEN_AUDIENCE = "https://kubernetes.default.svc.cluster.local"

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(() => getK8sBearerToken()).toThrow(/audience mismatch/)
  })

  it("accepts a token whose audience matches a configured K8S_TOKEN_AUDIENCE", async () => {
    const file = join(dir, "token")
    writeFileSync(file, fakeJwt({ aud: "https://custom-api.narwhal.internal" }))
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file
    process.env.K8S_TOKEN_AUDIENCE = "https://custom-api.narwhal.internal"

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(getK8sBearerToken()).toBe(readFileSync(file, "utf8").trim())
  })

  it("passes through an opaque (non-JWT) token unchecked", async () => {
    const file = join(dir, "token")
    writeFileSync(file, "opaque-non-jwt-token")
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
    process.env.K8S_SA_TOKEN_FILE = file

    const { getK8sBearerToken } = await import("./k8s-token")
    expect(getK8sBearerToken()).toBe("opaque-non-jwt-token")
  })
})
