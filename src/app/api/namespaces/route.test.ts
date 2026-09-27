import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  requireRole: vi.fn(),
}))
vi.mock("@/lib/k8s-client", () => ({ getNamespacesForScope: vi.fn() }))
vi.mock("@/lib/gitea", () => ({
  GiteaError: class GiteaError extends Error { status = 500 },
  GiteaCredentialError: class GiteaCredentialError extends Error {},
  isGiteaConfigured: vi.fn(() => true),
  requestTenantNamespace: vi.fn(),
}))
vi.mock("@/lib/scope", () => ({ getEffectiveScope: vi.fn(), namespaceVisible: vi.fn(() => true) }))
vi.mock("@/lib/namespace-ownership", () => ({ resolveNamespaceOwner: vi.fn(() => ({ ok: true, team: "team-a" })) }))
vi.mock("@/lib/operation-context", () => ({
  beginOperation: vi.fn().mockResolvedValue({}), completeOperation: vi.fn(), failOperation: vi.fn(),
}))
vi.mock("@/lib/cache-invalidation", () => ({ invalidateFor: vi.fn().mockResolvedValue(undefined) }))

const { requireRole } = await import("@/lib/auth")
const { requestTenantNamespace } = await import("@/lib/gitea")
const { invalidateFor } = await import("@/lib/cache-invalidation")
const { POST } = await import("./route")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ session: { teams: ["team-a"], user: { role: "developer", email: "dev@example.com" } } } as never)
  vi.mocked(requestTenantNamespace).mockResolvedValue({ pullRequestNumber: 17, pullRequestUrl: "https://git.example/pr/17" } as never)
})

describe("POST /api/namespaces", () => {
  it("invalidates namespace dependent views after opening the request", async () => {
    const req = new Request("http://localhost/api/namespaces", { method: "POST", body: JSON.stringify({ name: "dev-team-a", team: "team-a" }) })
    expect((await POST(req)).status).toBe(200)
    expect(invalidateFor).toHaveBeenCalledWith("namespace.changed", { namespace: "dev-team-a" })
  })

  it("does not invalidate when opening the namespace request fails", async () => {
    vi.mocked(requestTenantNamespace).mockRejectedValue(new Error("Git service unavailable"))
    const req = new Request("http://localhost/api/namespaces", { method: "POST", body: JSON.stringify({ name: "dev-team-a", team: "team-a" }) })
    expect((await POST(req)).status).toBe(502)
    expect(invalidateFor).not.toHaveBeenCalled()
  })
})
