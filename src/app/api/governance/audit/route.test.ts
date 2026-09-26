import { beforeEach, describe, expect, it, vi } from "vitest"
import type { K8sEvent } from "@/lib/k8s-client"

// portal#16: /api/governance/audit surfaces Kubernetes Events, which are an
// operational signal, not authoritative Kubernetes Audit evidence. These
// tests pin two things: (1) the response is explicitly labeled as such, and
// (2) an event producer field (reportingComponent/source.component) can
// never be presented as a user/API actor identity.

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getEvents: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { cacheGet, cacheSet } = await import("@/lib/valkey")
const { getEvents } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const adminSession = { session: { user: { role: "cluster-admin" } } }

function fakeEvent(overrides: Partial<K8sEvent> = {}): K8sEvent {
  return {
    type: "Normal",
    reason: "Scheduled",
    message: "Successfully assigned default/pod-a to node-1",
    namespace: "default",
    involvedObject: { kind: "Pod", name: "pod-a", namespace: "default" },
    lastTimestamp: new Date().toISOString(),
    firstTimestamp: new Date().toISOString(),
    reportingComponent: "default-scheduler",
    source: { component: "default-scheduler", host: "node-1" },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue(adminSession as never)
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
})

describe("GET /api/governance/audit — role gate", () => {
  it("returns 401 without a session and never touches the event source", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getEvents).not.toHaveBeenCalled()
  })

  it("returns 403 for a role outside cluster-admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" } as never)
    const res = await GET()
    expect(res.status).toBe(403)
    expect(getEvents).not.toHaveBeenCalled()
  })
})

describe("GET /api/governance/audit — cache key (#16)", () => {
  it("never reads the pre-#16 'governance:audit' cache entry, whose shape carried actor", async () => {
    vi.mocked(getEvents).mockResolvedValue([fakeEvent()])
    await GET()
    const keys = vi.mocked(cacheGet).mock.calls.map(([k]) => k)
    expect(keys).not.toContain("governance:audit")
    expect(vi.mocked(cacheSet).mock.calls[0]?.[0]).toBe("governance:operational-events:v2")
  })
})

describe("GET /api/governance/audit — operational-event labeling (#16)", () => {
  it("marks every entry as an operational event, never audit evidence", async () => {
    vi.mocked(getEvents).mockResolvedValue([fakeEvent()])

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].evidenceKind).toBe("operational-event")
  })

  it("never exposes an `actor` field, and exposes the event producer only as reportingComponent", async () => {
    vi.mocked(getEvents).mockResolvedValue([fakeEvent({ reportingComponent: "kubelet", source: { component: "kubelet", host: "node-2" } })])

    const res = await GET()
    const body = await res.json()

    expect(body[0]).not.toHaveProperty("actor")
    expect(body[0]).not.toHaveProperty("user")
    expect(body[0].reportingComponent).toBe("kubelet")
  })

  it("falls back to source.component, still under reportingComponent, when reportingComponent is absent", async () => {
    vi.mocked(getEvents).mockResolvedValue([
      fakeEvent({ reportingComponent: undefined, source: { component: "cronjob-controller", host: "node-3" } }),
    ])

    const res = await GET()
    const body = await res.json()

    expect(body[0]).not.toHaveProperty("actor")
    expect(body[0].reportingComponent).toBe("cronjob-controller")
  })

  it("never fabricates a user identity when no producer field is present", async () => {
    vi.mocked(getEvents).mockResolvedValue([fakeEvent({ reportingComponent: undefined, source: undefined })])

    const res = await GET()
    const body = await res.json()

    expect(body[0]).not.toHaveProperty("actor")
    expect(body[0].reportingComponent).toBe("unknown")
  })
})
