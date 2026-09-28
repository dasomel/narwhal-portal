import { beforeEach, describe, expect, it, vi } from "vitest"
import type { K8sEvent } from "@/lib/k8s-client"

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGetWithMeta: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getEventsBounded: vi.fn() }
})

const { requireRole } = await import("@/lib/auth")
const { cacheGetWithMeta, cacheSet } = await import("@/lib/valkey")
const { getEventsBounded } = await import("@/lib/k8s-client")
const { GET: getAudit } = await import("./route")
const { GET: getEvents } = await import("../events/route")
const adminSession = { session: { user: { role: "cluster-admin" } } }

function fakeEvent(): K8sEvent {
  return {
    type: "Normal", reason: "Scheduled", message: "Scheduled pod", namespace: "default",
    involvedObject: { kind: "Pod", name: "pod-a", namespace: "default" },
    lastTimestamp: new Date().toISOString(), firstTimestamp: new Date().toISOString(),
    reportingComponent: "default-scheduler", source: { component: "default-scheduler", host: "node-1" },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue(adminSession as never)
  vi.mocked(cacheGetWithMeta).mockResolvedValue(null)
  vi.mocked(cacheSet).mockResolvedValue(undefined)
  vi.mocked(getEventsBounded).mockResolvedValue({ items: [fakeEvent()], truncated: false })
})

describe("governance operational event routes", () => {
  it("returns the metadata envelope and propagates listBounded truncation", async () => {
    vi.mocked(getEventsBounded).mockResolvedValue({ items: [fakeEvent()], truncated: true })
    const res = await getEvents()
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.truncated).toBe(true)
    expect(body.evidenceKind).toBe("operational-event")
    expect(body.freshness.source).toBe("live")
    expect(body.items[0]).not.toHaveProperty("actor")
  })

  it("keeps the audit alias array and supplies successor/deprecation headers", async () => {
    vi.mocked(getEventsBounded).mockResolvedValue({ items: [fakeEvent()], truncated: true })
    const res = await getAudit()
    expect(await res.json()).toHaveLength(1)
    expect(res.headers.get("X-Truncated")).toBe("true")
    expect(res.headers.get("Deprecation")).toBe("@1790553600")
    expect(res.headers.get("Link")).toBe('</api/governance/events>; rel="successor-version"')
  })

  it("uses the same 401 and 403 gate for both routes", async () => {
    for (const status of [401, 403]) {
      vi.mocked(requireRole).mockResolvedValue({ error: status === 401 ? "unauthorized" : "forbidden" } as never)
      expect((await getEvents()).status).toBe(status)
      expect((await getAudit()).status).toBe(status)
    }
  })
})
