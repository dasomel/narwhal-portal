import { describe, it, expect, vi, beforeEach } from "vitest"
import { GET, POST } from "./route"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "u1", name: "Alice", role: "developer" },
    idToken: "sample-id-token",
  }),
}))

describe("Federated Logout API (Issue #56)", () => {
  beforeEach(() => {
    process.env.KEYCLOAK_ISSUER = "https://keycloak.local.narwhal.internal/realms/narwhal"
    process.env.KEYCLOAK_CLIENT_ID = "narwhal-portal"
    process.env.AUTH_URL = "https://portal.local.narwhal.internal"
    process.env.SLO_CHAIN_START = "https://gitea.local.narwhal.internal/apisix/logout"
  })

  it("rejects GET requests with 405 Method Not Allowed", async () => {
    const res = await GET()
    expect(res.status).toBe(405)
    const json = await res.json()
    expect(json.error).toContain("Method Not Allowed")
  })

  it("rejects cross-site POST requests via sec-fetch-site", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
      headers: {
        "sec-fetch-site": "cross-site",
      },
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })

  it("rejects cross-origin POST requests with mismatched origin", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
      headers: {
        host: "portal.local.narwhal.internal",
        origin: "https://evil-site.com",
      },
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })

  it("rejects POST requests without Origin or Sec-Fetch-Site", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
  })

  it("accepts POST requests explicitly marked same-origin", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
      },
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
  })

  it("accepts valid same-origin POST and returns Keycloak SLO url", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
      headers: {
        host: "portal.local.narwhal.internal",
        origin: "https://portal.local.narwhal.internal",
      },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.url).toContain("https://keycloak.local.narwhal.internal/realms/narwhal/protocol/openid-connect/logout")
    expect(json.url).toContain("post_logout_redirect_uri")
    expect(json.url).toContain("id_token_hint=sample-id-token")
  })

  it("keeps the configured SLO redirect when a requested redirect is not allowed", async () => {
    const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
      method: "POST",
      headers: {
        host: "portal.local.narwhal.internal",
        origin: "https://portal.local.narwhal.internal",
        "content-type": "application/json",
      },
      body: JSON.stringify({ redirectUri: "https://evil-site.example/logout" }),
    })
    const res = await POST(req)
    const json = await res.json()
    const logoutUrl = new URL(json.url)

    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://gitea.local.narwhal.internal/apisix/logout"
    )
  })
})
