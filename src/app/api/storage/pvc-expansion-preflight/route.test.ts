import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/k8s-client")>(),
  getPersistentVolumeClaim: vi.fn(),
  getStorageClass: vi.fn(),
}))
vi.mock("@/lib/scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/scope")>(),
  getEffectiveScope: vi.fn(),
}))

const { requireRole } = await import("@/lib/auth")
const { getPersistentVolumeClaim, getStorageClass, K8sHttpError } = await import("@/lib/k8s-client")
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
  vi.mocked(getPersistentVolumeClaim).mockResolvedValue(pvc())
})

describe("POST /api/storage/pvc-expansion-preflight", () => {
  it.each([["unauthorized", 401], ["forbidden", 403]] as const)("rejects %s", async (error, status) => {
    vi.mocked(requireRole).mockResolvedValue({ error } as never)
    const res = await POST(request())
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: status === 401 ? "Unauthorized" : "Forbidden" })
    expect(requireRole).toHaveBeenCalledWith("cluster-admin", "developer")
    expect(getEffectiveScope).not.toHaveBeenCalled()
    expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
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
    expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON", async () => {
    expect((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status).toBe(400)
    expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
  })

  it("denies a cluster mismatch without echoing it", async () => {
    const res = await POST(request({ ...input, cluster_id: "unregistered" }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(getEffectiveScope).not.toHaveBeenCalled()
    expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
  })

  it("denies an out-of-scope namespace before any PVC read", async () => {
    const res = await POST(request({ ...input, namespace: "other-team", scope: { all: true } }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
    expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
  })

  it("returns 404 only for an in-scope PVC lookup", async () => {
    vi.mocked(getPersistentVolumeClaim).mockRejectedValue(new K8sHttpError(404, "secret path"))
    const res = await POST(request())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it.each(["scope", "pvc"])("fails closed when %s lookup throws", async (lookup) => {
    const error = new Error("secret upstream detail")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      if (lookup === "scope") vi.mocked(getEffectiveScope).mockRejectedValue(error)
      else vi.mocked(getPersistentVolumeClaim).mockRejectedValue(error)
      const res = await POST(request())
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "Cluster unavailable" })
      expect(log).toHaveBeenCalledWith("PVC expansion preflight cluster lookup failed", error)
      if (lookup === "scope") expect(getPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(getStorageClass).not.toHaveBeenCalled()
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
      facts: { current_bytes_text: "10Gi", storage_class_name: "standard", expansion_supported: null, phase: "Bound", resize_in_progress: false },
      evidence_gaps: ["storage-class", "quota"],
    })
    expect(getPersistentVolumeClaim).toHaveBeenCalledExactlyOnceWith(input.namespace, input.pvc_name)
    expect(getEffectiveScope).toHaveBeenCalledWith(expect.objectContaining({ teams: ["team-a"] }), DEFAULT_CLUSTER_ID)
  })

  it.each([
    [true, "needs-evidence", ["quota-evidence-missing"]],
    [false, "blocked", ["class-expansion-unsupported", "quota-evidence-missing"]],
    [undefined, "blocked", ["class-expansion-unsupported", "quota-evidence-missing"]],
  ])("handles readable expansion field %j", async (allowVolumeExpansion, verdict, reasons) => {
    vi.mocked(getStorageClass).mockResolvedValue({
      ...(allowVolumeExpansion === undefined ? {} : { allowVolumeExpansion }),
      provisioner: "SECRET-SC-PROVISIONER", parameters: { token: "SECRET-SC-PARAM" },
      kind: "StorageClass",
      metadata: { name: "standard", annotations: { token: "SECRET-SC-ANNOTATION" } },
    })
    const res = await POST(request())
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result).toMatchObject({ verdict, reasons, evidence_gaps: ["quota"],
      facts: { expansion_supported: allowVolumeExpansion === true } })
    expect(result.verdict).not.toBe("allowed")
    expect(getStorageClass).toHaveBeenCalledExactlyOnceWith("standard")
    expect(vi.mocked(getPersistentVolumeClaim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getStorageClass).mock.invocationCallOrder[0])
    for (const secret of ["SECRET-SC-PROVISIONER", "SECRET-SC-PARAM", "SECRET-SC-ANNOTATION", "parameters", "annotations", "provisioner"]) {
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it.each([403, 404, 500, "throw"])("keeps class unknown on read failure %s", async (failure) => {
    const error = typeof failure === "number" ? new K8sHttpError(failure, "secret") : new Error("secret")
    vi.mocked(getStorageClass).mockRejectedValue(error)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await POST(request())
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ verdict: "needs-evidence",
        reasons: ["class-unknown", "quota-evidence-missing"],
        evidence_gaps: ["storage-class", "quota"], facts: { expansion_supported: null } })
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it.each([
    null, [], "secret", 1, {},
    { kind: "Status", metadata: { name: "standard" }, status: "Success" },
    { kind: "StorageClass", metadata: { name: "other" } },
    { kind: "StorageClass" },
    Object.create({ kind: "StorageClass", metadata: { name: "standard" } }),
    { kind: "StorageClass", metadata: Object.create({ name: "standard" }) },
    Object.assign(Object.create({ metadata: { name: "standard" } }), { kind: "StorageClass" }),
    ...["true", 1, null].map((allowVolumeExpansion) => ({
      kind: "StorageClass", metadata: { name: "standard" }, allowVolumeExpansion,
    })),
  ])("keeps malformed class unknown %j", async (value) => {
    vi.mocked(getStorageClass).mockResolvedValue(value)
    expect(await (await POST(request())).json()).toMatchObject({ verdict: "needs-evidence",
      reasons: ["class-unknown", "quota-evidence-missing"],
      evidence_gaps: ["storage-class", "quota"], facts: { expansion_supported: null } })
  })

  it.each([undefined, null, "", "UPPER", "bad/name", "standard\n", "a".repeat(254), 1, {}])("does not request absent or invalid class %j", async (storageClassName) => {
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue({ ...pvc(), spec: { storageClassName } })
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "needs-evidence", evidence_gaps: ["storage-class", "quota"],
      facts: { storage_class_name: null, expansion_supported: null },
    })
    expect(getStorageClass).not.toHaveBeenCalled()
  })

  it.each([
    ["10Gi", "standard", "Bound", []],
    ["1Gi", "fast.ssd", "Pending", []],
    ["10Gi", "standard", "Lost", []],
    ["10Gi", "standard", "Bound", [{ type: "Resizing", status: "True" }]],
    ["garbage", "standard", "Bound", null],
    [null, null, null, []],
  ])("never allows expansion with unread quota: %j %j %j", async (current, storageClassName, phase, conditions) => {
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue({
      spec: { storageClassName }, status: { capacity: { storage: current }, phase, conditions },
    })
    for (const expansion of [true, false, null]) {
      vi.mocked(getStorageClass).mockResolvedValue({
        kind: "StorageClass", metadata: { name: storageClassName }, allowVolumeExpansion: expansion,
      })
      const res = await POST(request())
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.verdict).not.toBe("allowed")
      expect(result.evidence_gaps).toContain("quota")
    }
  })

  it.each([
    ["garbage", "UPPER", "Unknown"],
    ["x".repeat(1000), "a".repeat(254), "Bound\n"],
    ["10Gi\n", "standard\n", "SECRET-PHASE"],
    [123, {}, []],
  ])("redacts invalid cluster strings: %j %j %j", async (current, storageClassName, phase) => {
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue({
      spec: { storageClassName }, status: { capacity: { storage: current }, phase, conditions: [] },
    })
    expect(await (await POST(request())).json()).toMatchObject({
      facts: { current_bytes_text: null, storage_class_name: null, phase: null },
    })
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
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue(pvc([{ type, status: "True" }]))
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "blocked", reasons: expect.arrayContaining(["resize-in-progress"]), facts: { resize_in_progress: true },
    })
  })

  it.each([null, {}, [null], [{ type: "Resizing" }], [{ type: "Resizing", status: true }]])("requires evidence for malformed conditions %j", async (conditions) => {
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue(pvc(conditions))
    expect(await (await POST(request())).json()).toMatchObject({
      verdict: "needs-evidence", reasons: expect.arrayContaining(["resize-state-unknown"]), facts: { resize_in_progress: null },
    })
  })

  it("requires evidence for absent conditions", async () => {
    const live = pvc()
    delete (live.status as { conditions?: unknown }).conditions
    vi.mocked(getPersistentVolumeClaim).mockResolvedValue(live)
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
