import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockGetK8sApiServer = vi.fn(() => "https://kubernetes.default.svc")
const mockGetK8sBearerToken = vi.fn(() => "test-token")
const mockInvalidateK8sBearerToken = vi.fn()
const mockPing = vi.fn()

vi.mock("./config", () => ({
  getK8sApiServer: () => mockGetK8sApiServer(),
}))

vi.mock("./k8s-token", () => ({
  getK8sBearerToken: () => mockGetK8sBearerToken(),
  invalidateK8sBearerToken: () => mockInvalidateK8sBearerToken(),
}))

vi.mock("./valkey", () => ({
  getValkey: () => ({ ping: () => mockPing() }),
}))

import {
  fromTelemetryStatus,
  fromProbeState,
  fromBoundedListTruncated,
  SCORECARD_UNAVAILABLE_STATE,
  probeHttpDependency,
  probeK8sDependency,
  probeValkeyDependency,
} from "./dependency-health"

describe("dependency-health vocabulary mapping (portal#47)", () => {
  it("fromTelemetryStatus reuses TelemetryStatus values verbatim except ambiguous", () => {
    expect(fromTelemetryStatus("ok")).toBe("ok")
    expect(fromTelemetryStatus("empty")).toBe("empty")
    expect(fromTelemetryStatus("partial")).toBe("partial")
    expect(fromTelemetryStatus("unavailable")).toBe("unavailable")
    expect(fromTelemetryStatus("stale")).toBe("stale")
    expect(fromTelemetryStatus("ambiguous")).toBe("partial")
  })

  it("fromProbeState maps the /api/health/status vocabulary", () => {
    expect(fromProbeState("healthy")).toBe("ok")
    expect(fromProbeState("degraded")).toBe("partial")
    expect(fromProbeState("unavailable")).toBe("unavailable")
    expect(fromProbeState("unconfigured")).toBe("unavailable")
  })

  it("fromBoundedListTruncated maps listBounded's truncated flag", () => {
    expect(fromBoundedListTruncated(false)).toBe("ok")
    expect(fromBoundedListTruncated(true)).toBe("partial")
  })

  it("scorecard's unavailable CheckResult state maps 1:1 (pass/fail have no dependency-health mapping)", () => {
    expect(SCORECARD_UNAVAILABLE_STATE).toBe("unavailable")
  })
})

describe("probeHttpDependency", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports unavailable with reason 'unconfigured' when no URL is set, without calling fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    const result = await probeHttpDependency("argocd", undefined)

    expect(result).toMatchObject({ dependency: "argocd", state: "unavailable", reason: "unconfigured" })
    expect(result.detail).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports ok on a 2xx probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))

    const result = await probeHttpDependency("argocd", "https://argocd.narwhal.internal")

    expect(result).toMatchObject({ dependency: "argocd", state: "ok" })
    expect(result.reason).toBeUndefined()
  })

  it("reports unauthorized on a 401/403 probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response))

    const result = await probeHttpDependency("gitea", "https://gitea.narwhal.internal")

    expect(result).toMatchObject({ dependency: "gitea", state: "unauthorized", reason: "http_401" })
  })

  it("reports partial on a non-2xx, non-401/403 probe response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))

    const result = await probeHttpDependency("gitea", "https://gitea.narwhal.internal")

    expect(result).toMatchObject({ dependency: "gitea", state: "partial", reason: "http_503" })
  })

  it("reports unavailable with a redacted (hostname, no query/userinfo) detail on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))

    const result = await probeHttpDependency("keycloak", "https://keycloak.narwhal.internal/realms/x?secret=abc")

    expect(result.dependency).toBe("keycloak")
    expect(result.state).toBe("unavailable")
    expect(result.reason).toBe("network")
    expect(result.detail).toContain("keycloak.narwhal.internal")
    expect(result.detail).not.toContain("secret=abc")
  })
})

describe("probeK8sDependency", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reports ok on a successful namespaces probe, ignoring pagination completeness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response)
    )

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "ok" })
  })

  it("reports unauthorized on a 401 that survives the token-refresh retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response))

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "unauthorized", reason: "http_401" })
    expect(mockInvalidateK8sBearerToken).toHaveBeenCalled()
  })

  it("reports unavailable when the connection is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))

    const result = await probeK8sDependency()

    expect(result).toMatchObject({ dependency: "kubernetes", state: "unavailable", reason: "timeout_or_network" })
  })

  it("reports unavailable when the probe exceeds its timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})) // never resolves
    )

    const result = await probeK8sDependency({ timeoutMs: 20 })

    expect(result).toMatchObject({ dependency: "kubernetes", state: "unavailable", reason: "timeout_or_network" })
  })
})

describe("probeValkeyDependency", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("reports unavailable with reason 'unconfigured' when neither VALKEY_URL nor VALKEY_PASSWORD is set", async () => {
    delete process.env.VALKEY_URL
    delete process.env.VALKEY_PASSWORD

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "unavailable", reason: "unconfigured" })
    expect(mockPing).not.toHaveBeenCalled()
  })

  it("reports ok on a successful PONG", async () => {
    process.env.VALKEY_URL = "redis://valkey:6379"
    mockPing.mockResolvedValue("PONG")

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "ok" })
  })

  it("reports unavailable when the ping rejects", async () => {
    process.env.VALKEY_URL = "redis://valkey:6379"
    mockPing.mockRejectedValue(new Error("connection closed"))

    const result = await probeValkeyDependency()

    expect(result).toMatchObject({ dependency: "valkey", state: "unavailable", reason: "timeout_or_network" })
  })
})
