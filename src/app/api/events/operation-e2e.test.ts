import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Session } from "next-auth"
import type { ArgoApp } from "@/lib/argocd"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn(), getActorId: (s: Session) => s.user?.email ?? "unknown" }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return {
    ...actual,
    assertAppAccessible: vi.fn(),
    syncArgoApp: vi.fn(),
    rollbackArgoApp: vi.fn(),
  }
})
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn().mockResolvedValue([]) }
})
vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getLiveValkey: vi.fn().mockImplementation(() => {
    throw new Error("Valkey unavailable in test environment")
  }),
}))

const { auth } = await import("@/lib/auth")
const { assertAppAccessible, syncArgoApp, rollbackArgoApp } = await import("@/lib/argocd")
const { POST: catalogSyncPOST } = await import("../catalog/[name]/sync/route")
const { POST: catalogRollbackPOST } = await import("../catalog/[name]/rollback/route")
const { GET: streamGET } = await import("./stream/route")
const { getRecentEvents } = await import("@/lib/live-stream")

const adminSession: Session = {
  user: { email: "admin@example.com", name: "Admin User", role: "cluster-admin" },
  groups: ["cluster-admin"],
  teams: ["ops-team"],
  expires: "2026-12-31T23:59:59Z",
}

const mockApp: ArgoApp = {
  metadata: { name: "my-service" },
  spec: { project: "default", destination: { namespace: "payments" } },
  status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
}

function params(name: string) {
  return { params: Promise.resolve({ name }) }
}

describe("E2E Operation Context Lifecycle & Stream Retrieval (portal#11)", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(assertAppAccessible).mockResolvedValue(mockApp)
    vi.mocked(syncArgoApp).mockResolvedValue({ name: "my-service", syncStatus: "Synced", revision: "a1b2c3d" })
    vi.mocked(rollbackArgoApp).mockResolvedValue(true)
  })

  it("end-to-end: mutation route request -> operation.started/completed emission -> stream/retrieval", async () => {
    const correlationId = "corr-e2e-12345"
    const requestId = "req-e2e-67890"

    const req = new Request("http://localhost/api/catalog/my-service/sync", {
      method: "POST",
      headers: {
        "x-correlation-id": correlationId,
        "x-request-id": requestId,
      },
    })

    // 1. Trigger catalog sync mutation route
    const res = await catalogSyncPOST(req, params("my-service"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)

    // 2. Fetch emitted events via getRecentEvents
    const recent = await getRecentEvents(20)
    const startedEvent = recent.find((e) => e.event_type === "operation.started" && e.correlation_id === correlationId)
    const completedEvent = recent.find((e) => e.event_type === "operation.completed" && e.correlation_id === correlationId)

    expect(startedEvent).toBeDefined()
    expect(completedEvent).toBeDefined()

    // Assert canonical envelope / operation context fields
    expect(startedEvent!.operation_id).toBeDefined()
    expect(completedEvent!.operation_id).toBe(startedEvent!.operation_id)
    expect(startedEvent!.correlation_id).toBe(correlationId)
    expect(startedEvent!.causation_id).toBe(correlationId)
    expect(startedEvent!.request_id).toBe(requestId)
    expect(startedEvent!.actor).toEqual({
      id: "admin@example.com",
      type: "user",
      displayName: "Admin User",
    })
    expect(startedEvent!.resource).toEqual({
      kind: "Application",
      namespace: "payments",
      name: "my-service",
      cluster: DEFAULT_CLUSTER_ID,
    })

    // 3. Assert events are also streamable via SSE endpoint (/api/events/stream)
    const streamReq = new Request("http://localhost/api/events/stream")
    const streamRes = await streamGET(streamReq)
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get("content-type")).toBe("text/event-stream")

    const reader = streamRes.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read()
      if (done || !value) break
      text += decoder.decode(value)
      if (text.includes(`"correlation_id":"${correlationId}"`)) break
    }

    expect(text).toContain(": connected")
    expect(text).toContain(`"correlation_id":"${correlationId}"`)
    expect(text).toContain(`"request_id":"${requestId}"`)
    expect(text).toContain(`"operation_id":"${startedEvent!.operation_id}"`)
  })

  it("emits operation.failed event when mutation step fails", async () => {
    vi.mocked(rollbackArgoApp).mockRejectedValueOnce(new Error("K8s cluster unreachable"))

    const correlationId = "corr-fail-999"
    const req = new Request("http://localhost/api/catalog/my-service/rollback", {
      method: "POST",
      headers: {
        "x-correlation-id": correlationId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: 5 }),
    })

    const res = await catalogRollbackPOST(req, params("my-service"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("K8s cluster unreachable")

    const recent = await getRecentEvents(20)
    const failedEvent = recent.find((e) => e.event_type === "operation.failed" && e.correlation_id === correlationId)

    expect(failedEvent).toBeDefined()
    expect(failedEvent!.severity).toBe("error")
    expect(failedEvent!.description).toContain("K8s cluster unreachable")
    expect(failedEvent!.actor?.id).toBe("admin@example.com")
  })
})
