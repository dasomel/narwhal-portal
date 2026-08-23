import { describe, expect, it, vi } from "vitest"
import type { Session } from "next-auth"

// operation-context.ts pulls in auth.ts (for getActorId), which calls NextAuth(config)
// at module load time — that pulls in next-auth's "next/server" import, which fails to
// resolve under vitest's plain-Node environment (same pre-existing issue auth.test.ts
// works around). Stub it out rather than loading the real thing.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))

// pushEvent's real fail-open path (src/lib/live-stream.ts) only helps when Valkey
// rejects fast; under vitest there's no Valkey at all and the connection attempt can
// hang past the test timeout instead of failing synchronously. Stub it so these tests
// exercise beginOperation's own logic (ids, header handling, actor derivation) without
// depending on network behavior.
vi.mock("./live-stream", () => ({ pushEvent: vi.fn().mockResolvedValue(undefined) }))

const { beginOperation, completeOperation, failOperation } = await import("./operation-context")
const { pushEvent } = await import("./live-stream")

function fakeSession(overrides: Partial<Session["user"]> = {}): Session {
  return {
    user: { email: "alice@example.com", name: "Alice", role: "developer", ...overrides },
    groups: [],
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as Session
}

function fakeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://portal.local/api/test", { headers })
}

describe("beginOperation", () => {
  it("mints a fresh correlation id with no causation parent when no header is present", async () => {
    const ctx = await beginOperation({
      request: fakeRequest(),
      session: fakeSession(),
      operationType: "argocd.sync",
      source: "argocd",
      resource: { kind: "Application", name: "api" },
      title: "test",
    })
    expect(ctx.correlationId).toBe(ctx.operationId)
    expect(ctx.causationId).toBeNull()
    expect(ctx.requestId).toBeNull()
  })

  it("adopts an inbound X-Correlation-Id as both correlation id and causation parent", async () => {
    const ctx = await beginOperation({
      request: fakeRequest({ "x-correlation-id": "corr-123" }),
      session: fakeSession(),
      operationType: "argocd.sync",
      source: "argocd",
      resource: {},
      title: "test",
    })
    expect(ctx.correlationId).toBe("corr-123")
    expect(ctx.causationId).toBe("corr-123")
    expect(ctx.operationId).not.toBe("corr-123")
  })

  it("carries an inbound X-Request-Id through separately from correlation", async () => {
    const ctx = await beginOperation({
      request: fakeRequest({ "x-request-id": "req-456" }),
      session: fakeSession(),
      operationType: "node.tuning.apply",
      source: "kubernetes",
      resource: { kind: "Node", name: "worker-1" },
      title: "test",
    })
    expect(ctx.requestId).toBe("req-456")
  })

  it("threads request_id through to the emitted operation.started event", async () => {
    vi.mocked(pushEvent).mockClear()
    await beginOperation({
      request: fakeRequest({ "x-request-id": "req-789" }),
      session: fakeSession(),
      operationType: "node.tuning.apply",
      source: "kubernetes",
      resource: {},
      title: "test",
    })
    expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({ request_id: "req-789" }))
  })

  it("derives the actor from the session, preferring email as the stable id", async () => {
    const ctx = await beginOperation({
      request: fakeRequest(),
      session: fakeSession({ email: "bob@example.com", name: "Bob" }),
      operationType: "alert.silence.create",
      source: "alertmanager",
      resource: {},
      title: "test",
    })
    expect(ctx.actor).toEqual({ id: "bob@example.com", type: "user", displayName: "Bob" })
  })

  it("ignores blank headers the same as absent ones", async () => {
    const ctx = await beginOperation({
      request: fakeRequest({ "x-correlation-id": "   " }),
      session: fakeSession(),
      operationType: "argocd.sync",
      source: "argocd",
      resource: {},
      title: "test",
    })
    expect(ctx.correlationId).toBe(ctx.operationId)
    expect(ctx.causationId).toBeNull()
  })
})

describe("completeOperation / failOperation", () => {
  it("resolve without throwing when the event pipeline (mocked) succeeds", async () => {
    const ctx = await beginOperation({
      request: fakeRequest(),
      session: fakeSession(),
      operationType: "argocd.sync",
      source: "argocd",
      resource: {},
      title: "test",
    })
    await expect(completeOperation(ctx, "done")).resolves.toBeUndefined()
    await expect(failOperation(ctx, "failed", "boom")).resolves.toBeUndefined()
  })
})
