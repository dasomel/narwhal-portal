import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { NodeDetail } from "@/lib/k8s-client"

// #55: failure-injection / security coverage for the privileged node-tuning apply
// route — compromised/wrong-role session, tampered payload (bad kind + allowlist
// bypass at the tuning-commands.ts layer), control-plane targeting bypass (taint
// AND label paths, checked separately in the route), and job-escape proof (a
// pre-validation rejection must never reach runHostJob).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
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

const { auth } = await import("@/lib/auth")
const { runHostJob } = await import("@/lib/k8s-job-runner")
const { getNodeDetail } = await import("@/lib/k8s-client")
const { POST } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }
const developerSession = { user: { role: "developer", email: "dev@example.com" } }

const workerNode = {
  taints: [],
  labels: {},
} as unknown as NodeDetail

const controlPlaneTaintNode = {
  taints: [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }],
  labels: {},
} as unknown as NodeDetail

const controlPlaneLabelNode = {
  taints: [],
  labels: { "node-role.kubernetes.io/master": "" },
} as unknown as NodeDetail

function req(body: unknown, nodeName = "node-1") {
  return new NextRequest(`http://localhost/api/nodes/${nodeName}/tuning/apply`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function ctx(nodeName = "node-1") {
  return { params: Promise.resolve({ name: nodeName }) }
}

beforeEach(() => {
  // Call history (toHaveBeenCalled / not.toHaveBeenCalled) must not leak between
  // tests in this file — clear it before re-establishing the default mock behavior.
  vi.clearAllMocks()
  vi.mocked(getNodeDetail).mockResolvedValue(workerNode)
  vi.mocked(runHostJob).mockResolvedValue({ ok: true, logs: "NARWHAL_VERIFY_0=0\n", jobName: "narwhal-tuning-1" })
})

describe("POST /api/nodes/[name]/tuning/apply — auth boundary", () => {
  it("401s an unauthenticated (compromised/expired) session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(401)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("403s an authenticated session whose role is not cluster-admin", async () => {
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

  it("403s when the target node carries the control-plane/master label instead of a taint", async () => {
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

  it("400s an item whose kind is not in VALID_KINDS, even with extra smuggled fields", async () => {
    const res = await POST(
      req({ items: [{ kind: "exec-raw-shell", cmd: "rm -rf /", extra: "smuggled" }] }),
      ctx(),
    )
    expect(res.status).toBe(400)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a valid kind whose field fails the tuning-commands.ts allowlist (kernel-module) and never runs the job", async () => {
    const res = await POST(req({ items: [{ kind: "kernel-module", module: "evil_module" }] }), ctx())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/module not allowed/)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a tuning-script path-traversal attempt and never runs the job (job-escape proof)", async () => {
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
    const body = await res.json()
    expect(body.error).toMatch(/too many items/)
    expect(runHostJob).not.toHaveBeenCalled()
  })

  it("400s a malformed body (not an object)", async () => {
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

describe("POST /api/nodes/[name]/tuning/apply — positive control", () => {
  it("200s and runs the job for a valid admin session, non-control-plane node, allowlisted items", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx("node-1"))
    expect(res.status).toBe(200)
    expect(runHostJob).toHaveBeenCalledWith({
      nodeName: "node-1",
      targets: [{ kind: "swap-off" }],
      label: "tuning",
      timeoutMs: 5 * 60_000,
    })
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.jobName).toBe("narwhal-tuning-1")
  })
})

describe("POST /api/nodes/[name]/tuning/apply — post-apply verification", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("500s when runHostJob succeeds but the re-read host state doesn't match what was requested", async () => {
    // requested value "1", but the job's re-read marker reports "0" — the apply
    // command exited 0 yet the host state doesn't actually reflect the change.
    vi.mocked(runHostJob).mockResolvedValue({ ok: true, logs: "NARWHAL_VERIFY_0=0\n", jobName: "narwhal-tuning-2" })
    const res = await POST(
      req({ items: [{ kind: "kernel-param", param: "net.ipv4.ip_forward", value: "1" }] }),
      ctx(),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

describe("POST /api/nodes/[name]/tuning/apply — job execution failure", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("500s and surfaces the error when runHostJob rejects", async () => {
    vi.mocked(runHostJob).mockRejectedValue(new Error("job timeout"))
    const res = await POST(req({ items: [{ kind: "swap-off" }] }), ctx())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/job timeout/)
  })
})
