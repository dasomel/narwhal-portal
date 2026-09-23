import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// /api/health/status fans out up to 8 outbound probes per call and reports which
// backend dependencies are down — gated to cluster-admin (see status/route.ts) so it
// can't be used as an unauthenticated amplification vector / dependency topology leak.
// Default the mock to an authorized admin session so the existing "what does the body
// look like" tests below don't each need their own auth setup; the dedicated access
// control tests override this per case.
vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue({
    session: { user: { role: "cluster-admin" }, groups: ["cluster-admin"], teams: [] },
  }),
}))

import { GET as getLive } from "./live/route"
import { GET as getReady } from "./ready/route"
import { GET as getStatus } from "./status/route"
import { requireRole } from "@/lib/auth"

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

describe("status diagnostics access control (Issue #63 review fix)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(requireRole).mockResolvedValue({
      session: { user: { role: "cluster-admin" }, groups: ["cluster-admin"], teams: [] },
    } as never)
  })

  it("rejects an unauthenticated caller with 401 and does not fan out any probes", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ error: "unauthorized" } as never)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const res = await getStatus()
    const json = await res.json()

    expect(res.status).toBe(401)
    expect(json).toEqual({ error: "Unauthorized" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rejects a non-admin session with 403 and does not fan out any probes", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ error: "forbidden" } as never)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const res = await getStatus()
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json).toEqual({ error: "Forbidden" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns the full diagnostics body for a cluster-admin session", async () => {
    const res = await getStatus()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.dependencies).toBeDefined()
    expect(requireRole).toHaveBeenCalledWith("cluster-admin")
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
