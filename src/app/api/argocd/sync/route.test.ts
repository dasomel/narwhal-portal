import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { Session } from "next-auth"
import type { ArgoApp } from "@/lib/argocd"

vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}))
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: unknown) => opts,
}))

vi.mock("@/lib/auth", () => ({ requireRole: vi.fn(), getActorId: (s: Session) => s.user?.email ?? "unknown" }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return {
    ...actual,
    assertAppAccessible: vi.fn(),
    syncArgoApp: vi.fn(),
    getArgoAppFresh: vi.fn(),
  }
})
vi.mock("@/lib/valkey", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  getLiveValkey: vi.fn().mockImplementation(() => {
    throw new Error("Valkey unavailable in test environment")
  }),
}))

const { requireRole } = await import("@/lib/auth")
const { assertAppAccessible, syncArgoApp, getArgoAppFresh, ArgoCDCredentialError } = await import("@/lib/argocd")
const { POST } = await import("./route")

const devSession: Session = {
  user: { email: "dev@example.com", name: "Dev User", role: "developer" },
  groups: ["developer"],
  teams: ["app-team"],
  expires: "2026-12-31T23:59:59Z",
}

const mockApp: ArgoApp = {
  metadata: { name: "checkout-api" },
  spec: { project: "ecommerce", destination: { namespace: "storefront" } },
  status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
}

const convergedApp: ArgoApp = {
  ...mockApp,
  status: {
    sync: { status: "Synced" },
    health: { status: "Healthy" },
    operationState: { phase: "Succeeded" },
  },
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/argocd/sync", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/argocd/sync", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({ session: devSession } as never)
    vi.mocked(assertAppAccessible).mockResolvedValue(mockApp)
    vi.mocked(syncArgoApp).mockResolvedValue({ name: "checkout-api", syncStatus: "Synced", revision: "rev-100" })
    vi.mocked(getArgoAppFresh).mockResolvedValue(convergedApp)
  })

  it("401s an unauthenticated request", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "unauthorized" } as never)
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(401)
  })

  it("403s a guest role caller", async () => {
    vi.mocked(requireRole).mockResolvedValue({ error: "forbidden" } as never)
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(403)
  })

  it("400s when appName is missing", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it("400s an invalid app name", async () => {
    const res = await POST(req({ appName: "INVALID_NAME!" }))
    expect(res.status).toBe(400)
  })

  it("syncs and reports ok on convergence", async () => {
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it("reports pending when the sync is accepted but not yet converged", async () => {
    vi.mocked(getArgoAppFresh).mockResolvedValue(mockApp) // no operationState -> not converged
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pending).toBe(true)
  })

  it("reports failure (502) when the operation reaches a terminal Failed phase", async () => {
    vi.mocked(getArgoAppFresh).mockResolvedValue({
      ...mockApp,
      status: { ...mockApp.status, operationState: { phase: "Failed" } },
    })
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  // D1 (#54 review): syncArgoApp is a WRITE path and keeps throwing
  // ArgoCDCredentialError; the route fails closed with 503 instead of a bare
  // 502, so a rejected/missing ARGOCD_TOKEN reads as "unavailable", not a
  // generic sync failure.
  it("returns 503 when syncArgoApp throws ArgoCDCredentialError", async () => {
    vi.mocked(syncArgoApp).mockRejectedValue(
      new ArgoCDCredentialError("ArgoCD sync rejected (HTTP 401): check ARGOCD_TOKEN"),
    )
    const res = await POST(req({ appName: "checkout-api" }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("ArgoCD sync is unavailable")
  })
})
