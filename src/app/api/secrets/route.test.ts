import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// portal#19: GET /api/secrets must fail explicitly degraded (structured 502 body,
// degraded: true) when listSecrets() can't read metadata, instead of the old
// silent `return NextResponse.json([])` that made a permission/connectivity
// failure indistinguishable from "no secrets exist". listSecrets() itself is
// mocked here — its metadata-only fetch behavior is covered by openbao.test.ts —
// so this stays a pure route-boundary test (auth gate, response shape, audit log).
vi.mock("@/lib/auth", () => ({ auth: vi.fn(), getActorId: vi.fn(() => "actor@example.com") }))
vi.mock("@/lib/openbao", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openbao")>()
  return { ...actual, listSecrets: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { listSecrets, SecretMetadataError } = await import("@/lib/openbao")
const { GET } = await import("./route")

const adminSession = { user: { role: "cluster-admin", email: "admin@example.com" } }
const viewerSession = { user: { role: "viewer", email: "viewer@example.com" } }

function request(headers?: Record<string, string>) {
  return new NextRequest("http://localhost/api/secrets", { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/secrets", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET(request())
    expect(res.status).toBe(401)
  })

  it("returns 403 for a non-admin caller", async () => {
    vi.mocked(auth).mockResolvedValue(viewerSession as never)
    const res = await GET(request())
    expect(res.status).toBe(403)
    expect(listSecrets).not.toHaveBeenCalled()
  })

  it("returns the metadata-only entries for a cluster-admin caller", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const entries = [{ path: "keycloak-token", version: 1, createdTime: "t", updatedTime: "t" }]
    vi.mocked(listSecrets).mockResolvedValue(entries)

    const res = await GET(request())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(entries)
  })

  it("logs an auditable actor+correlation record for the read", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(listSecrets).mockResolvedValue([])
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})

    await GET(request({ "x-correlation-id": "corr-123" }))

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("secrets.list"))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("corr-123"))
    infoSpy.mockRestore()
  })

  it("fails explicitly degraded (502, degraded:true) instead of silently returning an empty list", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(listSecrets).mockRejectedValue(new SecretMetadataError("Failed to list secret metadata (HTTP 403)"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const res = await GET(request())

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.degraded).toBe(true)
    expect(body.error).toContain("Failed to list secret metadata")
    warnSpy.mockRestore()
  })
})
