import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { NodeDetail } from "@/lib/k8s-client"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(), getActorId: vi.fn((s) => s.user.email ?? "unknown") }))
vi.mock("@/lib/k8s-job-runner", () => ({ runHostJob: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNodeDetail: vi.fn() }
})
vi.mock("@/lib/operation-context", () => ({
  beginOperation: vi.fn().mockResolvedValue({}),
  completeOperation: vi.fn().mockResolvedValue(undefined),
  failOperation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/tuning-approval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tuning-approval")>()
  return { ...actual, consumeTuningApproval: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { runHostJob } = await import("@/lib/k8s-job-runner")
const { getNodeDetail } = await import("@/lib/k8s-client")
const { consumeTuningApproval } = await import("@/lib/tuning-approval")
const { POST } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }
const developerSession = { user: { role: "developer", email: "dev@example.com" } }

const workerNode = { taints: [], labels: {} } as unknown as NodeDetail
const controlPlaneTaintNode = {
  taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }],
  labels: {},
} as unknown as NodeDetail
const controlPlaneLabelNode = {
  taints: [],
  labels: { "node-role.kubernetes.io/master": "" },
} as unknown as NodeDetail

const approval = {
  approvalId: "approval-1",
  resolutionId: "resolution-1",
  invocationDigest: "sha256:test",
  canonicalizationVersion: "narwhal-json-c14n/v1",
  approvedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2099-09-08T00:02:00.000Z",
}

function req(body: unknown, nodeName = "node-1", withApproval = true) {
  let payload = body
  if (
    withApproval &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "items" in body &&
    !("approval" in body)
  ) {
    payload = { ...(body as Record<string, unknown>), approval }
  }
  return new NextRequest(`http://localhost/api/nodes/${nodeName}/tuning/apply`, {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

function ctx(nodeName = "node-1") {
  return { params: Promise.resolve({ name: nodeName }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNodeDetail).mockResolvedValue(workerNode)
  vi.mocked(runHostJob).mockResolvedValue({ ok: true, logs: "NARWHAL_VERIFY_0=0\n", jobName: "narwhal-tuning-1" })
  vi.mocked(consumeTuningApproval).mockResolvedValue({
    ok: true,
    artifact: {
      resolutionId: "resolution-1",
      invocationDigest: "sha256:test",
      canonicalizationVersion: "narwhal-json-c14n/v1",
      normalizedInvocationVersion: "v1",
    },
  } as never)
})

describe("POST /api/nodes/[name]/tuning/apply — auth boundary", () => {
  it("401s an unauthenticated session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(401)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("403s a non-cluster-admin session", async () => {
    vi.mocked(auth).mockResolvedValue(developerSession as never)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(403)
    expect(runHostJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/nodes/[name]/tuning/apply — node targeting bypass", () => {
  it("403s when the target node carries the control-plane taint", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(getNodeDetail).mockResolvedValue(controlPlaneTaintNode)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(403)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("403s when the target node carries the control-plane/master label", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(getNodeDetail).mockResolvedValue(controlPlaneLabelNode)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(403)
    expect(runHostJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/nodes/[name]/tuning/apply — tampered payload", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("400s an invalid kind even with smuggled fields", async () => {
    const res = await POST(req({ items: [{ kind: "exec-raw-shell", cmd: "rm -rf /", extra: "smuggled" }] }), ctx())
    expect(res.status).toBe(400)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a kernel-module allowlist bypass", async () => {
    const res = await POST(req({ items: [{ kind: "kernel-module", module: "evil_module" }] }), ctx())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/module not allowed/)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a tuning-script path traversal", async () => {
    const res = await POST(req({ items: [{ kind: "tuning-script", script: "../../etc/shadow" }] }), ctx())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/script not allowed/)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s when items exceeds the 50-item cap", async () => {
    const items = Array.from({ length: 51 }, () => ({ kind: "swap-off" }))
    const res = await POST(req({ items }), ctx())
    expect(res.status).toBe(400)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a malformed body", async () => {
    const res = await POST(req("not json at all"), ctx())
    expect(res.status).toBe(400)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s an empty items array", async () => {
    const res = await POST(req({ items: [] }), ctx())
    expect(res.status).toBe(400)
    expect(runHostJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/nodes/[name]/tuning/apply — exact approval boundary", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("400s a valid mutation without an approval envelope", async () => {
    const res = await POST(req({ items: [{ kind: "swap-off" }] }, "node-1", false), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/approval required/)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("409s when exact invocation approval revalidation fails", async () => {
    vi.mocked(consumeTuningApproval).mockResolvedValue({
      ok: false,
      reason: "invocation-digest-mismatch",
    })
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe("invocation-digest-mismatch")
    expect(runHostJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/nodes/[name]/tuning/apply — positive control", () => {
  it("200s and runs the job only after approval succeeds", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx("node-1"))
    expect(res.status).toBe(200)
    expect(consumeTuningApproval).toHaveBeenCalled()
    expect(runHostJob).toHaveBeenCalledWith({
      nodeName: "node-1",
      targets: [{ kind: "swap-off" }],
      label: "tuning",
      timeoutMs: 5 * 60_000,
    })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.evidence.approvalId).toBe("approval-1")
    expect(body.evidence.invocationDigest).toBe("sha256:test")
  })
})

describe("POST /api/nodes/[name]/tuning/apply — post-apply verification", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("500s when the re-read host state does not match", async () => {
    vi.mocked(runHostJob).mockResolvedValue({ ok: true, logs: "NARWHAL_VERIFY_0=0\n", jobName: "narwhal-tuning-2" })
    const res = await POST(
      req({ items: [{ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" }] }),
      ctx(),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})

describe("POST /api/nodes/[name]/tuning/apply — job execution failure", () => {
  it("500s and preserves approval evidence when the job rejects", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(runHostJob).mockRejectedValue(new Error("job timeout"))
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/job timeout/)
    expect(body.evidence.approvalId).toBe("approval-1")
  })
})
