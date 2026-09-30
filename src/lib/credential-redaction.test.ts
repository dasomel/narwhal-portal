import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const CANARY = "credential-canary-54-do-not-log"

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? { name: item.name, message: item.message, cause: item.cause }
    : item)
}

describe("provider credential redaction and rotation", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "development"
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("redacts rejected Keycloak credentials and distinguishes provider outage", async () => {
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = "portal-admin"
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = CANARY
    const logs = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const { getKeycloakAdminToken, KeycloakCredentialError, KeycloakUnavailableError } = await import("./keycloak-client")
    const error = await getKeycloakAdminToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(KeycloakCredentialError)
    expect(serialized(error)).not.toContain(CANARY)
    expect(logs.mock.calls.map(serialized).join()).not.toContain(CANARY)
    if (!(error instanceof Error)) throw error
    expect(error.cause).toBeUndefined()

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    await expect(getKeycloakAdminToken(true)).rejects.toBeInstanceOf(KeycloakUnavailableError)
  })

  it("uses a rotated Keycloak client secret on the next forced token request", async () => {
    const bodies: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return Response.json({ access_token: `kc-token-${bodies.length}`, expires_in: 3600 })
    }))
    process.env.KEYCLOAK_ADMIN_CLIENT_ID = "portal-admin"
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "kc-secret-old"
    const { getKeycloakAdminToken } = await import("./keycloak-client")
    await expect(getKeycloakAdminToken()).resolves.toBe("kc-token-1")
    process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = "kc-secret-new"
    await expect(getKeycloakAdminToken(true)).resolves.toBe("kc-token-2")
    expect(bodies[0]).toContain("client_secret=kc-secret-old")
    expect(bodies[1]).toContain("client_secret=kc-secret-new")
  })

  it("re-reads rotated ArgoCD and Gitea environment credentials", async () => {
    const calls: Array<string | undefined> = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push((init?.headers as Record<string, string>)?.Authorization)
      return Response.json({ metadata: { name: "app" }, status: { sync: { status: "Synced" } } })
    }))
    process.env.ARGOCD_TOKEN = "argo-old"
    const argo = await import("./argocd")
    await argo.syncArgoApp("app")
    process.env.ARGOCD_TOKEN = "argo-new"
    await argo.syncArgoApp("app")
    expect(calls.slice(0, 2)).toEqual(["Bearer argo-old", "Bearer argo-new"])

    vi.resetModules()
    process.env.GITEA_TOKEN = "gitea-old"
    process.env.GITEA_URL = "http://gitea.test"
    const gitea = await import("./gitea")
    await gitea.requestTenantNamespace({ namespace: "dev-alpha", team: "team-a", requestedBy: "alice" }).catch(() => {})
    process.env.GITEA_TOKEN = "gitea-new"
    await gitea.requestTenantNamespace({ namespace: "dev-beta", team: "team-a", requestedBy: "alice" }).catch(() => {})
    expect(calls.slice(2)).toContain("token gitea-old")
    expect(calls.slice(2)).toContain("token gitea-new")
    expect(calls.slice(2).indexOf("token gitea-old")).toBeLessThan(calls.slice(2).indexOf("token gitea-new"))
  })

  it("redacts ArgoCD read/write errors and ArgoCD/Gitea credential logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    process.env.ARGOCD_TOKEN = CANARY
    const argo = await import("./argocd")
    const argoError = await argo.syncArgoApp("app").then(() => null, (e: unknown) => e)
    expect(argoError).toBeInstanceOf(argo.ArgoCDCredentialError)
    expect(serialized(argoError)).not.toContain(CANARY)
    await expect(argo.getArgoApps()).resolves.toEqual([])
    await expect(argo.getArgoApp("app")).resolves.toBeNull()
    const readError = await argo.getArgoAppsOrThrow().then(() => null, (e: unknown) => e)
    expect(readError).toBeInstanceOf(argo.ArgoCDCredentialError)
    expect(serialized(readError)).not.toContain(CANARY)

    process.env.GITEA_TOKEN = CANARY
    process.env.GITEA_URL = "http://gitea.test"
    const gitea = await import("./gitea")
    await expect(gitea.requestTenantNamespace({ namespace: "dev-alpha", team: "team-a", requestedBy: "alice" }))
      .rejects.toBeInstanceOf(gitea.GiteaCredentialError)
    await expect(gitea.getCommitTimestamp("sha-redaction" )).resolves.toBeNull()
    expect(log).toHaveBeenCalled()
    const logged = log.mock.calls.map(serialized).join()
    expect(logged).not.toContain(CANARY)

    const k8s = await import("./k8s-client")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const k8sError = await k8s.listBounded("/api/v1/pods").then(() => null, (e: unknown) => e)
    expect(k8sError).toBeInstanceOf(k8s.K8sCredentialError)
    expect(serialized(k8sError)).not.toContain(CANARY)
  })

  it("distinguishes Gitea credential rejection from unavailable provider", async () => {
    process.env.GITEA_TOKEN = CANARY
    process.env.GITEA_URL = "http://gitea.test"
    const gitea = await import("./gitea")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    await expect(gitea.requestTenantNamespace({ namespace: "dev-alpha", team: "team-a", requestedBy: "alice" }))
      .rejects.toBeInstanceOf(gitea.GiteaCredentialError)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")))
    const unavailable = await gitea.requestTenantNamespace({ namespace: "dev-beta", team: "team-a", requestedBy: "alice" })
      .then(() => null, (e: unknown) => e)
    expect(unavailable).not.toBeInstanceOf(gitea.GiteaCredentialError)
    expect(serialized(unavailable)).not.toContain(CANARY)
  })

  it("documents missing OpenBao production token as untyped, see follow-up", async () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
    process.env.OPENBAO_AUTH_METHOD = "token"
    delete process.env.OPENBAO_TOKEN
    const { getOpenBaoToken } = await import("./openbao")
    await expect(getOpenBaoToken()).rejects.toThrowError(Error)
    await expect(getOpenBaoToken()).rejects.toThrow(/Missing required production configuration/)
  })

  it("re-reads OpenBao static tokens between calls", async () => {
    process.env.OPENBAO_AUTH_METHOD = "token"
    process.env.OPENBAO_TOKEN = "bao-old"
    const { getOpenBaoToken } = await import("./openbao")
    await expect(getOpenBaoToken()).resolves.toBe("bao-old")
    process.env.OPENBAO_TOKEN = "bao-new"
    await expect(getOpenBaoToken()).resolves.toBe("bao-new")
  })
})
