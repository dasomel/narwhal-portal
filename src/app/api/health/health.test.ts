import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { GET as getLive } from "./live/route"
import { GET as getReady } from "./ready/route"
import { GET as getStatus } from "./status/route"

describe("Health Endpoints (Issue #63 & #60)", () => {
  it("liveness probe returns HTTP 200 with process info", async () => {
    const res = await getLive()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("ok")
    expect(json.service).toBe("narwhal-portal")
    expect(typeof json.uptime).toBe("number")
    expect(typeof json.pid).toBe("number")
  })

  it("readiness probe returns status and checks", async () => {
    const res = await getReady()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("ready")
    expect(json.checks.config).toBe("ok")
  })

  it("liveness does not call fetch or read dependency config", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    await getLive()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("status diagnostics returns non-sensitive topology", async () => {
    const res = await getStatus()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dependencies).toBeDefined()
    expect(json.config).toBeDefined()
    // Ensure no secrets or passwords leaked
    const text = JSON.stringify(json)
    expect(text).not.toContain("password")
    expect(text).not.toContain("clientSecret")
    expect(text).not.toContain("bearer")
  })
})

describe("readiness probe missing-config case (Issue #63)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("returns HTTP 503 with the list of missing required config when production config is incomplete", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    delete process.env.AUTH_MOCK
    delete process.env.KEYCLOAK_ISSUER
    delete process.env.K8S_API_SERVER
    delete process.env.KUBERNETES_SERVICE_HOST

    const res = await getReady()
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(json.status).toBe("not_ready")
    expect(json.missing).toContain("KEYCLOAK_ISSUER")
  })
})

describe("status diagnostics dependency states (Issue #63)", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it("marks an unconfigured optional dependency without probing it, and does not degrade overall status", async () => {
    delete process.env.ARGOCD_URL
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const res = await getStatus()
    const json = await res.json()

    expect(json.dependencies.argocd).toEqual({ required: false, state: "unconfigured" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(json.status).toBe("healthy")
  })

  it("classifies a dependency as healthy on a 2xx probe response", async () => {
    process.env.ARGOCD_URL = "https://argocd.narwhal.internal"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    const res = await getStatus()
    const json = await res.json()

    expect(json.dependencies.argocd).toEqual({ required: false, state: "healthy" })
  })

  it("classifies a dependency as degraded on a non-2xx probe response, without flipping overall status when optional", async () => {
    process.env.ARGOCD_URL = "https://argocd.narwhal.internal"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))

    const res = await getStatus()
    const json = await res.json()

    expect(json.dependencies.argocd).toEqual({ required: false, state: "degraded" })
    expect(json.status).toBe("healthy")
  })

  it("classifies a dependency as unavailable when the probe rejects", async () => {
    process.env.ARGOCD_URL = "https://argocd.narwhal.internal"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const res = await getStatus()
    const json = await res.json()

    expect(json.dependencies.argocd).toEqual({ required: false, state: "unavailable" })
  })

  it("degrades overall status when a required dependency (Keycloak) is unavailable", async () => {
    process.env.KEYCLOAK_ISSUER = "https://keycloak.narwhal.internal"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const res = await getStatus()
    const json = await res.json()

    expect(json.dependencies.keycloak).toEqual({ required: true, state: "unavailable" })
    expect(json.status).toBe("degraded")
  })

  it("does not expose the configured dependency URLs in the response", async () => {
    process.env.ARGOCD_URL = "https://argocd.narwhal.internal"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    const res = await getStatus()
    const text = JSON.stringify(await res.json())

    expect(text).not.toContain("argocd.narwhal.internal")
  })
})
