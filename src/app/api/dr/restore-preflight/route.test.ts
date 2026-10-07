import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/k8s-client", () => ({ getNamespacesForScope: vi.fn() }))
vi.mock("@/lib/scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/scope")>(),
  getEffectiveScope: vi.fn(),
}))

const { requireRole } = await import("@/lib/auth")
const { getNamespacesForScope } = await import("@/lib/k8s-client")
const { getEffectiveScope } = await import("@/lib/scope")
const { REQUIRED_RESTORE_PREFLIGHT_CHECKS } = await import("@/lib/domain/restore")
const { POST } = await import("./route")

const { DEFAULT_CLUSTER_ID } = await import("@/types/cluster")

const input = {
  cluster_id: DEFAULT_CLUSTER_ID,
  backup_id: "backup-1",
  source_namespace: "source",
  target_namespace: "dev-team-a",
}
const passingChecks = REQUIRED_RESTORE_PREFLIGHT_CHECKS.map((check_id) => ({ check_id, status: "pass" }))
function request(body: unknown = input) {
  return new Request("http://localhost/api/dr/restore-preflight", {
    method: "POST", body: JSON.stringify(body), headers: { "x-correlation-id": "correlation-1" },
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ session: { teams: ["team-a"], user: { role: "developer" } } } as never)
  vi.mocked(getEffectiveScope).mockResolvedValue({ all: false, namespaces: new Set([input.source_namespace, input.target_namespace]) } as never)
  vi.mocked(getNamespacesForScope).mockResolvedValue([
    { name: input.target_namespace, labels: { "narwhal.io/team": "team-a" } },
  ] as never)
})

describe("POST /api/dr/restore-preflight", () => {
  it.each([ ["unauthorized", 401], ["forbidden", 403] ] as const)("rejects %s", async (error, status) => {
    vi.mocked(requireRole).mockResolvedValue({ error } as never)
    expect((await POST(request())).status).toBe(status)
    expect(requireRole).toHaveBeenCalledWith("cluster-admin", "developer")
    expect(getEffectiveScope).not.toHaveBeenCalled()
  })

  it.each([
    null, [], {}, { ...input, cluster_id: "" }, { ...input, backup_id: 1 },
    { ...input, source_namespace: "UPPER" }, { ...input, target_namespace: "a".repeat(64) },
    { ...input, target_namespace: "bad.name" },
    { ...input, cluster_id: "a".repeat(254) }, { ...input, backup_id: "a".repeat(254) },
  ])("rejects invalid input %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(getEffectiveScope).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON", async () => {
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400)
  })

  it("denies an out-of-scope target", async () => {
    vi.mocked(getNamespacesForScope).mockResolvedValue([
      { name: "other-team", labels: { "narwhal.io/team": "team-b" } },
    ] as never)
    expect((await POST(request({ ...input, target_namespace: "other-team" }))).status).toBe(403)
    expect(getNamespacesForScope).not.toHaveBeenCalled()
  })

  it("ignores caller identity and scope claims", async () => {
    const res = await POST(request({ ...input, team: "attacker", tenant: "attacker", actor: "attacker", approver: "attacker", state: "approved" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      verdict: "needs-evidence", tenant_scope: { namespace: input.target_namespace, owner_team: "team-a" },
      cluster_id: input.cluster_id, missing_check_ids: [...REQUIRED_RESTORE_PREFLIGHT_CHECKS], correlation_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    })
    expect(getEffectiveScope).toHaveBeenCalledWith(expect.objectContaining({ teams: ["team-a"] }), input.cluster_id)
  })

  it.each([{ namespaces: [] }, { namespaces: [{ name: input.target_namespace, labels: {} }] }, { namespaces: [{ name: input.target_namespace, labels: { "narwhal.io/team": " " } }] }])("fails closed without an owner %j", async ({ namespaces }) => {
    vi.mocked(getNamespacesForScope).mockResolvedValue(namespaces as never)
    expect((await POST(request({ ...input, team: "team-a" })))).toHaveProperty("status", 403)
  })

  it.each([passingChecks, {}, [null], [{ check_id: "storage", status: "fail" }]])("ignores caller checks %j", async (checks) => {
    const res = await POST(request({ ...input, checks }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      verdict: "needs-evidence", missing_check_ids: [...REQUIRED_RESTORE_PREFLIGHT_CHECKS],
    })
    expect(REQUIRED_RESTORE_PREFLIGHT_CHECKS).toHaveLength(9)
  })

  it("denies a cluster mismatch without echoing it", async () => {
    const res = await POST(request({ ...input, cluster_id: "unregistered" }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(getEffectiveScope).not.toHaveBeenCalled()
  })

  it("denies an out-of-scope source with an in-scope target", async () => {
    const res = await POST(request({ ...input, source_namespace: "other-team" }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(getNamespacesForScope).not.toHaveBeenCalled()
  })

  it.each(["scope", "namespaces"])("fails closed when %s lookup throws", async (lookup) => {
    const error = new Error("secret upstream detail")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (lookup === "scope") vi.mocked(getEffectiveScope).mockRejectedValue(error)
      else vi.mocked(getNamespacesForScope).mockRejectedValue(error)
      const res = await POST(request())
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "Cluster unavailable" })
      expect(log).toHaveBeenCalledWith("Restore preflight cluster lookup failed", error)
      if (lookup === "scope") expect(getNamespacesForScope).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it("accepts a 253-character backup id", async () => {
    expect((await POST(request({ ...input, backup_id: "a".repeat(253) }))).status).toBe(200)
  })

  it("treats a 253-character cluster id as a mismatch", async () => {
    expect((await POST(request({ ...input, cluster_id: "a".repeat(253) }))).status).toBe(403)
  })

  it("ignores the correlation header and mints unique UUIDs", async () => {
    const first = await (await POST(request())).json()
    const second = await (await POST(request())).json()
    expect(first.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first.correlation_id).not.toBe("correlation-1")
    expect(second.correlation_id).not.toBe(first.correlation_id)
  })

  it("mints a correlation ID when no header exists", async () => {
    const req = request()
    req.headers.delete("x-correlation-id")
    expect(await (await POST(req)).json()).toHaveProperty("correlation_id", expect.stringMatching(/^[0-9a-f-]{36}$/))
  })
})
