import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { validateRuntimeConfig, getK8sApiServer } from "./config"

describe("Runtime Configuration Validation (Issue #60)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("passes validation in development profile with defaults", () => {
    process.env.NODE_ENV = "development"
    const result = validateRuntimeConfig()
    expect(result.environment).toBe("development")
    expect(result.valid).toBe(true)
    expect(getK8sApiServer()).toBe("https://192.168.56.100:6443")
  })

  it("fails fast in production if required Keycloak variables are missing", () => {
    process.env.NODE_ENV = "production"
    delete process.env.AUTH_MOCK
    delete process.env.AUTH_SECRET
    delete process.env.KEYCLOAK_ISSUER
    delete process.env.KEYCLOAK_CLIENT_ID
    delete process.env.KEYCLOAK_CLIENT_SECRET
    delete process.env.K8S_API_SERVER
    delete process.env.KUBERNETES_SERVICE_HOST

    const result = validateRuntimeConfig()
    expect(result.valid).toBe(false)
    expect(result.missingRequired).toContain("KEYCLOAK_ISSUER")
    expect(result.missingRequired).toContain("K8S_API_SERVER")
    expect(() => getK8sApiServer()).toThrow(/Missing required production configuration/)
  })

  it("passes in production when all required variables are supplied", () => {
    process.env.NODE_ENV = "production"
    delete process.env.AUTH_MOCK
    process.env.AUTH_SECRET = "secret"
    process.env.KEYCLOAK_ISSUER = "https://keycloak.narwhal.internal"
    process.env.KEYCLOAK_CLIENT_ID = "portal"
    process.env.KEYCLOAK_CLIENT_SECRET = "secret"
    process.env.K8S_API_SERVER = "https://k8s.narwhal.internal:6443"

    const result = validateRuntimeConfig()
    expect(result.valid).toBe(true)
    expect(result.missingRequired.length).toBe(0)
    expect(getK8sApiServer()).toBe("https://k8s.narwhal.internal:6443")
  })
})
