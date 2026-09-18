import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Certificate } from "@/lib/k8s-client"

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  getActorId: vi.fn((s) => s.user.email ?? "unknown"),
}))
vi.mock("@/lib/k8s-client", () => ({
  getCertificate: vi.fn(),
  invalidateCertificatesCache: vi.fn().mockResolvedValue(undefined),
  renewCertificate: vi.fn(),
}))
vi.mock("@/lib/operation-context", () => ({
  beginOperation: vi.fn().mockResolvedValue({}),
  completeOperation: vi.fn().mockResolvedValue(undefined),
  failOperation: vi.fn().mockResolvedValue(undefined),
}))

const { auth } = await import("@/lib/auth")
const { getCertificate, invalidateCertificatesCache, renewCertificate } = await import("@/lib/k8s-client")
const { beginOperation, completeOperation, failOperation } = await import("@/lib/operation-context")
const { POST } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }
const developerSession = { user: { role: "developer", email: "dev@example.com" } }

const cert: Certificate = {
  name: "narwhal-tls",
  namespace: "platform-system",
  ready: true,
  notAfter: "2026-01-01T00:00:00.000Z",
  notBefore: "2025-01-01T00:00:00.000Z",
  dnsNames: ["narwhal.internal"],
  issuer: "letsencrypt",
  renewalTime: "2025-11-01T00:00:00.000Z",
}

function req(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/settings/certs/renew", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCertificate).mockResolvedValue(cert)
  vi.mocked(renewCertificate).mockResolvedValue(true)
})

describe("POST /api/settings/certs/renew — auth boundary", () => {
  it("401s an unauthenticated session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(401)
    expect(renewCertificate).not.toHaveBeenCalled()
  })

  it("403s a non-cluster-admin session", async () => {
    vi.mocked(auth).mockResolvedValue(developerSession as never)
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(403)
    expect(renewCertificate).not.toHaveBeenCalled()
  })
})

describe("POST /api/settings/certs/renew — invalid target", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("400s a missing name", async () => {
    const res = await POST(req({ namespace: "platform-system" }))
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("name")
    expect(getCertificate).not.toHaveBeenCalled()
  })

  it("400s a missing namespace", async () => {
    const res = await POST(req({ name: "narwhal-tls" }))
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("namespace")
  })

  it("404s a target that does not exist (eligibility check)", async () => {
    vi.mocked(getCertificate).mockResolvedValueOnce(null)
    const res = await POST(req({ name: "ghost-cert", namespace: "platform-system" }))
    expect(res.status).toBe(404)
    expect(renewCertificate).not.toHaveBeenCalled()
  })
})

describe("POST /api/settings/certs/renew — failed renewal", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("500s and emits operation.failed when renewCertificate returns false", async () => {
    vi.mocked(renewCertificate).mockResolvedValue(false)
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(500)
    expect(failOperation).toHaveBeenCalled()
    expect(invalidateCertificatesCache).not.toHaveBeenCalled()
  })
})

describe("POST /api/settings/certs/renew — cache invalidation and audit/event emission", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
  })

  it("invalidates the certs cache and emits operation.started/completed on a converged renewal", async () => {
    vi.mocked(getCertificate)
      .mockResolvedValueOnce(cert)
      .mockResolvedValueOnce({ ...cert, renewalTime: "2026-06-01T00:00:00.000Z" })
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.pending).toBeUndefined()
    expect(invalidateCertificatesCache).toHaveBeenCalled()
    expect(beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationType: "pki.certificate.renew" }),
    )
    expect(completeOperation).toHaveBeenCalled()
  })

  it("reports pending (not a hard success) when state has not converged yet", async () => {
    vi.mocked(getCertificate).mockResolvedValueOnce(cert).mockResolvedValueOnce(cert)
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.pending).toBe(true)
  })

  it("502s when post-renewal read-back finds the certificate gone", async () => {
    vi.mocked(getCertificate).mockResolvedValueOnce(cert).mockResolvedValueOnce(null)
    const res = await POST(req({ name: "narwhal-tls", namespace: "platform-system" }))
    expect(res.status).toBe(502)
    expect(failOperation).toHaveBeenCalled()
  })
})

describe("POST /api/settings/certs/renew — idempotency", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(getCertificate)
      .mockResolvedValueOnce(cert)
      .mockResolvedValueOnce({ ...cert, renewalTime: "2026-06-01T00:00:00.000Z" })
  })

  it("does not trigger a second renewal for a repeated Idempotency-Key", async () => {
    const first = await POST(
      req({ name: "narwhal-tls", namespace: "platform-system" }, { "Idempotency-Key": "retry-1" }),
    )
    expect(first.status).toBe(200)
    expect(renewCertificate).toHaveBeenCalledTimes(1)

    const second = await POST(
      req({ name: "narwhal-tls", namespace: "platform-system" }, { "Idempotency-Key": "retry-1" }),
    )
    expect(second.status).toBe(200)
    expect((await second.json()).duplicate).toBe(true)
    expect(renewCertificate).toHaveBeenCalledTimes(1)
  })

  it("rejects a concurrent request sharing an in-flight Idempotency-Key instead of re-renewing", async () => {
    let releaseFirst!: () => void
    const gate = new Promise<boolean>((resolve) => {
      releaseFirst = () => resolve(true)
    })
    vi.mocked(renewCertificate).mockReturnValueOnce(gate)

    const firstPromise = POST(
      req({ name: "narwhal-tls", namespace: "platform-system" }, { "Idempotency-Key": "concurrent-1" }),
    )
    // Let the first request's claim-then-await land before the second fires.
    await Promise.resolve()
    await Promise.resolve()

    const second = await POST(
      req({ name: "narwhal-tls", namespace: "platform-system" }, { "Idempotency-Key": "concurrent-1" }),
    )
    expect(second.status).toBe(409)
    expect((await second.json()).error).toBe("Conflict")

    releaseFirst()
    const first = await firstPromise
    expect(first.status).toBe(200)
    expect(renewCertificate).toHaveBeenCalledTimes(1)
  })
})
