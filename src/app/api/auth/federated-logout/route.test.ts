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

  // Substring/unanchored allowlist bypass regression (security review finding):
  // "localhost" and "127.0.0.1" must be exact-match hosts, not domain suffixes, since an
  // unanchored endsWith() lets any hostname that merely ends in those characters through.
  describe("redirect allowlist anchoring", () => {
    function postWithRedirect(redirectUri: string) {
      const req = new NextRequest("https://portal.local.narwhal.internal/api/auth/federated-logout", {
        method: "POST",
        headers: {
          host: "portal.local.narwhal.internal",
          origin: "https://portal.local.narwhal.internal",
          "content-type": "application/json",
        },
        body: JSON.stringify({ redirectUri }),
      })
      return POST(req)
    }

    async function resolvedRedirect(redirectUri: string) {
      const res = await postWithRedirect(redirectUri)
      const json = await res.json()
      return new URL(json.url).searchParams.get("post_logout_redirect_uri")
    }

    it("rejects a hostname that merely ends in 'localhost' (bypass regression)", async () => {
      expect(await resolvedRedirect("https://maliciouslocalhost/evil")).toBe(
        "https://gitea.local.narwhal.internal/apisix/logout"
      )
    })

    it("allows the exact host 'localhost'", async () => {
      expect(await resolvedRedirect("http://localhost/callback")).toBe("http://localhost/callback")
    })

    it("allows the exact host '127.0.0.1'", async () => {
      expect(await resolvedRedirect("http://127.0.0.1/callback")).toBe("http://127.0.0.1/callback")
    })

    it("rejects an unanchored lookalike of '127.0.0.1'", async () => {
      expect(await resolvedRedirect("https://evil127.0.0.1.attacker.com/phish")).toBe(
        "https://gitea.local.narwhal.internal/apisix/logout"
      )
    })

    // A hostname with extra characters immediately before "127.0.0.1" (no dot separator,
    // e.g. "myevilhost127.0.0.1") cannot reach isAllowedRedirectUrl's endsWith() check at all:
    // WHATWG URL host parsing sees a purely-numeric last label ("1") and forces strict IPv4
    // validation of the *entire* hostname, which throws for anything but a real dotted-quad
    // (verified: `new URL("https://myevilhost127.0.0.1/phish")` -> "Invalid URL"). That throw
    // is caught by isAllowedRedirectUrl's try/catch and rejected regardless of the anchoring
    // fix, so no test can demonstrate that specific bypass shape through the URL constructor.
    // The reachable unanchored-suffix bypass for a non-numeric-ending host is covered above
    // ("rejects a hostname that merely ends in 'localhost'"); this test instead confirms the
    // URL constructor itself refuses such inputs, so they can never reach the redirect.
    it("rejects a would-be '127.0.0.1' suffix lookalike because the URL constructor itself refuses it", () => {
      expect(() => new URL("https://myevilhost127.0.0.1/phish")).toThrow()
    })

    it("allows a legitimate .narwhal.internal subdomain", async () => {
      expect(await resolvedRedirect("https://portal.local.narwhal.internal/dashboard")).toBe(
        "https://portal.local.narwhal.internal/dashboard"
      )
    })

    it("rejects a lookalike host without the .narwhal.internal dot boundary (no regression)", async () => {
      expect(await resolvedRedirect("https://evilnarwhal.internal/phish")).toBe(
        "https://gitea.local.narwhal.internal/apisix/logout"
      )
    })

    it("rejects an attacker-controlled external host", async () => {
      expect(await resolvedRedirect("https://attacker.example.com/phish")).toBe(
        "https://gitea.local.narwhal.internal/apisix/logout"
      )
    })
  })
})
