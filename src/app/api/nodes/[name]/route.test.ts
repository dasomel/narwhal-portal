import { describe, expect, it, vi, beforeEach } from "vitest"
import type { NodeDetail } from "@/lib/k8s-client"

// portal#33: GET /api/nodes/[name] accepted any authenticated session — guest
// included — even though node telemetry follows the same requireRole
// (cluster-admin/developer/viewer) policy as every other non-tenant-scoped read
// (/api/cost, /api/scorecards, /api/service-graph). Mocking @/lib/auth's
// requireRole directly (not auth) matches src/app/api/cost/route.test.ts's
// rationale for requireRole-gated routes.
vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/k8s-client", () => ({ getNodeDetail: vi.fn() }))
vi.mock("@/lib/prometheus", () => ({ getNodeMetrics: vi.fn(), getNodePodCount: vi.fn() }))

const { requireRole } = await import("@/lib/auth")
const { getNodeDetail } = await import("@/lib/k8s-client")
const { getNodeMetrics, getNodePodCount } = await import("@/lib/prometheus")
const { GET } = await import("./route")

const nodeDetail: NodeDetail = {
  name: "node-1",
  internalIP: "10.0.0.1",
  externalIP: "",
  kubeletVersion: "v1.31.0",
  kubeProxyVersion: "v1.31.0",
  osImage: "Ubuntu",
  operatingSystem: "linux",
  kernelVersion: "6.8.0",
  architecture: "amd64",
  containerRuntime: "containerd",
  providerID: "",
  machineID: "",
  systemUUID: "",
  createdAt: "2026-01-01T00:00:00Z",
  conditions: [],
  labels: {},
  taints: [],
  capacity: { cpu: "4", memory: "16Gi", pods: "110" },
  allocatable: { cpu: "4", memory: "16Gi", pods: "110" },
  systemStatus: {
    rebootRequired: false,
    securityUpdates: 0,
    standardUpdates: 0,
    packageUpdates: [],
    k8sBinaries: [],
    kernelParams: [],
    kernelModules: [],
    resourceLimits: [],
    requiredPackages: [],
    diskTuning: [],
    lvmAutoExtend: null,
    nicTuning: [],
    runtimeStatus: [],
    cgroup: {} as NodeDetail["systemStatus"]["cgroup"],
    swap: {} as NodeDetail["systemStatus"]["swap"],
    k8sTuning: {} as NodeDetail["systemStatus"]["k8sTuning"],
  },
}

function params(name: string) {
  return { params: Promise.resolve({ name }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNodeDetail).mockResolvedValue(nodeDetail)
  vi.mocked(getNodeMetrics).mockResolvedValue([])
  vi.mocked(getNodePodCount).mockResolvedValue(5)
})

describe("GET /api/nodes/[name] — role policy", () => {
  it("401s an unauthenticated caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" })
    const res = await GET(new Request("http://localhost/api/nodes/node-1"), params("node-1"))
    expect(res.status).toBe(401)
    expect(getNodeDetail).not.toHaveBeenCalled()
  })

  it("403s a guest — node telemetry is not guest-visible under the documented policy", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" })
    const res = await GET(new Request("http://localhost/api/nodes/node-1"), params("node-1"))
    expect(res.status).toBe(403)
    expect(getNodeDetail).not.toHaveBeenCalled()
  })

  it("200s a viewer (non-admin, non-guest) reading fleet-wide node telemetry", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "viewer" } } } as never)
    const res = await GET(new Request("http://localhost/api/nodes/node-1"), params("node-1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe("node-1")
  })

  it("200s cluster-admin (fleet visibility retained)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ session: { user: { role: "cluster-admin" } } } as never)
    const res = await GET(new Request("http://localhost/api/nodes/node-1"), params("node-1"))
    expect(res.status).toBe(200)
  })
})
