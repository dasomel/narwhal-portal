import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/k8s-client")>(),
  k8sFetch: vi.fn(),
}))
vi.mock("@/lib/scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/scope")>(),
  getEffectiveScope: vi.fn(),
}))

const { requireRole } = await import("@/lib/auth")
const { k8sFetch, K8sHttpError } = await import("@/lib/k8s-client")
const { getEffectiveScope } = await import("@/lib/scope")
const { POST } = await import("./route")
const { DEFAULT_CLUSTER_ID } = await import("@/types/cluster")

const input = { cluster_id: DEFAULT_CLUSTER_ID, namespace: "dev-team-a", pvc_name: "data.app", requested_size: "20Gi" }
function request(body: unknown = input) {
  return new Request("http://localhost/api/storage/pvc-expansion-preflight", {
    method: "POST", body: JSON.stringify(body),
  })
}
function pvc(conditions: unknown = []) {
  return {
    metadata: { annotations: { token: "SECRET-PVC-ANNOTATION-924" }, labels: { team: "SECRET-TEAM-LABEL" } },
    spec: { storageClassName: "standard" },
    status: { capacity: { storage: "10Gi" }, phase: "Bound", conditions },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ session: { teams: ["team-a"], user: { role: "developer" } } } as never)
  vi.mocked(getEffectiveScope).mockResolvedValue({ all: false, namespaces: new Set([input.namespace]) } as never)
  vi.mocked(k8sFetch).mockResolvedValue(pvc())
})

describe("POST /api/storage/pvc-expansion-preflight", () => {
  it.each([["unauthorized", 401], ["forbidden", 403]] as const)("rejects %s", async (error, status) => {
    vi.mocked(requireRole).mockResolvedValue({ error } as never)
    const res = await POST(request())
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: status === 401 ? "Unauthorized" : "Forbidden" })
    expect(requireRole).toHaveBeenCalledWith("cluster-admin", "developer")
    expect(getEffectiveScope).not.toHaveBeenCalled()
    expect(k8sFetch).not.toHaveBeenCalled()
  })

  it.each([
    null, [], {}, { ...input, cluster_id: "" }, { ...input, cluster_id: 1 },
    { ...input, cluster_id: "a".repeat(254) }, { ...input, cluster_id: "bad id" },
    { ...input, namespace: 1 }, { ...input, namespace: "UPPER" }, { ...input, namespace: "bad.name" },
    { ...input, namespace: "a".repeat(64) }, { ...input, namespace: "valid\n" },
    { ...input, pvc_name: 1 }, { ...input, pvc_name: "" }, { ...input, pvc_name: "UPPER" },
    { ...input, pvc_name: "bad..name" }, { ...input, pvc_name: "bad/name" },
    { ...input, pvc_name: "-bad" }, { ...input, pvc_name: "bad.-name" },
    { ...input, pvc_name: "a".repeat(254) }, { ...input, pvc_name: "valid\n" },
    { ...input, requested_size: 1 }, { ...input, requested_size: "1".repeat(65) },
  ])("rejects invalid input %j", async (body) => {
    const res = await POST(request(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid request" })
    expect(getEffectiveScope).not.toHaveBeenCalled()
    expect(k8sFetch).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON", async () => {
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400)
    expect(k8sFetch).not.toHaveBeenCalled()
  })

  it("denies a cluster mismatch without echoing it", async () => {
    const res = await POST(request({ ...input, cluster_id: "unregistered" }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(getEffectiveScope).not.toHaveBeenCalled()
    expect(k8sFetch).not.toHaveBeenCalled()
  })

  it("denies an out-of-scope namespace before any PVC read", async () => {
    const res = await POST(request({ ...input, namespace: "other-team", scope: { all: true } }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(k8sFetch).not.toHaveBeenCalled()
  })

  it("returns 404 only for an in-scope PVC lookup", async () => {
    vi.mocked(k8sFetch).mockRejectedValue(new K8sHttpError(404, "secret path"))
    const res = await POST(request())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it.each(["scope", "pvc"])("fails closed when %s lookup throws", async (lookup) => {
    const error = new Error("secret upstream detail")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (lookup === "scope") vi.mocked(getEffectiveScope).mockRejectedValue(error)
      else vi.mocked(k8sFetch).mockRejectedValue(error)
      const res = await POST(request())
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "Cluster unavailable" })
      expect(log).toHaveBeenCalledWith("PVC expansion preflight cluster lookup failed", error)
      if (lookup === "scope") expect(k8sFetch).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it("returns only live facts and evidence gaps", async () => {
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      verdict: "needs-evidence", reasons: ["class-unknown", "quota-evidence-missing"],
      namespace: input.namespace, pvc_name: input.pvc_name,
      facts: { current_bytes_text: "10Gi", storage_class_name: "standard", phase: "Bound", resize_in_progress: false },
      evidence_gaps: ["storage-class", "quota"],
    })
    expect(k8sFetch).toHaveBeenCalledExactlyOnceWith(`/api/v1/namespaces/${encodeURIComponent(input.namespace)}/persistentvolumeclaims/${encodeURIComponent(input.pvc_name)}`)
    expect(getEffectiveScope).toHaveBeenCalledWith(expect.objectContaining({ teams: ["team-a"] }), DEFAULT_CLUSTER_ID)
  })

  it("ignores all caller-supplied facts", async () => {
    const baseline = await (await POST(request())).json()
    const res = await POST(request({
      ...input, currentBytes: "1Gi", storageClass: { allowVolumeExpansion: true }, quotaHeadroomBytes: "100Gi",
      boundPhase: "Bound", resizeInProgress: false, facts: { current_bytes_text: "1Gi" },
      status: { capacity: { storage: "1Gi" }, conditions: [] }, spec: { storageClassName: "forged" },
    }))
    expect(await res.json()).toEqual(baseline)
  })

  it.each(["10Gi", "9Gi"])("blocks requested size %s", async (requested_size) => {
    expect(await (await POST(request({ ...input, requested_size }))).json()).toMatchObject({
      verdict: "blocked", reasons: expect.arrayContaining(["requested-not-larger"]),
    })
  })

  it.each(["Resizing", "FileSystemResizePending"])("blocks %s True", async (type) => {
    vi.mocked(k8sFetch).mockResolvedValue(pvc([{ type, status: "True" }]))
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "blocked", reasons: expect.arrayContaining(["resize-in-progress"]), facts: { resize_in_progress: true },
    })
  })

  it.each([null, {}, [null], [{ type: "Resizing" }], [{ type: "Resizing", status: true }]])("requires evidence for malformed conditions %j", async (conditions) => {
    vi.mocked(k8sFetch).mockResolvedValue(pvc(conditions))
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "needs-evidence", reasons: expect.arrayContaining(["resize-state-unknown"]), facts: { resize_in_progress: null },
    })
  })

  it("requires evidence for absent conditions", async () => {
    const live = pvc()
    delete (live.status as { conditions?: unknown }).conditions
    vi.mocked(k8sFetch).mockResolvedValue(live)
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "needs-evidence", reasons: expect.arrayContaining(["resize-state-unknown"]),
    })
  })

  it("does not leak PVC annotations or labels", async () => {
    const json = await (await POST(request())).text()
    for (const secret of ["SECRET-PVC-ANNOTATION-924", "SECRET-TEAM-LABEL", "annotations", "labels", "metadata"]) {
      expect(json).not.toContain(secret)
    }
  })

  it("accepts a 253-character PVC subdomain", async () => {
    expect((await POST(request({ ...input, pvc_name: "a".repeat(253) }))).status).toBe(200)
  })

  it("blocks an unparseable quantity through the domain evaluator", async () => {
    expect(await (await POST(request({ ...input, requested_size: "garbage" }))).json()).toMatchObject({
      verdict: "blocked", reasons: expect.arrayContaining(["requested-unparseable"]),
    })
  })
})
