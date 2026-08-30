import { NextResponse, type NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { isSessionCookieChunk } from "@/lib/session-cookie"

// Valid allowed redirect hosts for post-logout.
// Exact hosts and dot-anchored domain suffixes are kept separate: "localhost" / "127.0.0.1"
// are single exact hosts, not suffixes, so an unanchored endsWith() on them would let a
// hostname like "maliciouslocalhost" pass (open redirect). ".narwhal.internal" is a real
// domain suffix, so its leading dot enforces a subdomain boundary.
const ALLOWED_REDIRECT_EXACT_HOSTS = ["localhost", "127.0.0.1"]
const ALLOWED_REDIRECT_HOST_SUFFIXES = [".narwhal.internal"]

export function isAllowedRedirectUrl(targetUrl: string, authUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl, authUrl || "http://localhost:3000")
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (authUrl) {
      const parsedAuth = new URL(authUrl)
      if (parsed.host === parsedAuth.host) return true
    }
    return (
      ALLOWED_REDIRECT_EXACT_HOSTS.includes(parsed.hostname) ||
      ALLOWED_REDIRECT_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
    )
  } catch {
    return false
  }
}

function clearSessionCookies(res: NextResponse, request: NextRequest, authUrl: string) {
  const isHttps = (authUrl || "").startsWith("https")
  const expire = (name: string, secure: boolean) =>
    res.cookies.set(name, "", {
      path: "/",
      expires: new Date(0),
      secure,
      httpOnly: true,
      sameSite: "lax",
    })

  expire("authjs.session-token", false)
  expire("authjs.callback-url", false)
  expire("authjs.csrf-token", false)

  if (isHttps) {
    expire("__Secure-authjs.session-token", true)
    expire("__Secure-authjs.callback-url", true)
    res.cookies.set("__Host-authjs.csrf-token", "", {
      path: "/",
      expires: new Date(0),
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    })
  }

  for (const { name } of request.cookies.getAll()) {
    if (isSessionCookieChunk(name)) {
      expire(name, name.startsWith("__Secure-"))
    }
  }
}

// Issue #56: Disallow GET to prevent cross-site logout trigger via simple image/link tags
export async function GET() {
  return NextResponse.json(
    { error: "Method Not Allowed. Federated logout requires a POST request." },
    { status: 405, headers: { Allow: "POST" } }
  )
}

// POST endpoint for CSRF-safe RP-initiated logout
export async function POST(request: NextRequest) {
  // CSRF / Same-Origin verification
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  const secFetchSite = request.headers.get("sec-fetch-site")

  if (!origin && !secFetchSite) {
    return NextResponse.json(
      { error: "Forbidden: logout request origin could not be verified" },
      { status: 403 }
    )
  }

  if (secFetchSite && secFetchSite === "cross-site") {
    return NextResponse.json(
      { error: "Forbidden: cross-site logout rejected" },
      { status: 403 }
    )
  }

  if (origin && host) {
    try {
      const originUrl = new URL(origin)
      if (originUrl.host !== host) {
        return NextResponse.json(
          { error: "Forbidden: cross-origin logout rejected" },
          { status: 403 }
        )
      }
    } catch {
      return NextResponse.json(
        { error: "Bad Request: invalid origin header" },
        { status: 400 }
      )
    }
  }

  const session = await auth()
  const issuer = process.env.KEYCLOAK_ISSUER
  const authUrl = process.env.AUTH_URL ?? ""
  const sloChainStart =
    process.env.SLO_CHAIN_START ?? "https://gitea.local.narwhal.internal/apisix/logout"
  const defaultRedirect = sloChainStart || `${authUrl}/login`

  // Allow client to specify post_logout_redirect if permitted
  let postLogoutRedirect = defaultRedirect
  try {
    const body = await request.json().catch(() => null)
    if (body?.redirectUri && typeof body.redirectUri === "string") {
      if (isAllowedRedirectUrl(body.redirectUri, authUrl)) {
        postLogoutRedirect = body.redirectUri
      }
    }
  } catch {
    // Ignore JSON parsing errors and use defaultRedirect
  }

  if (!isAllowedRedirectUrl(postLogoutRedirect, authUrl)) {
    postLogoutRedirect = `${authUrl}/login`
  }

  let target = postLogoutRedirect
  if (issuer) {
    const url = new URL(`${issuer}/protocol/openid-connect/logout`)
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect)
    const clientId = process.env.KEYCLOAK_CLIENT_ID
    if (clientId) url.searchParams.set("client_id", clientId)
    if (session?.idToken) url.searchParams.set("id_token_hint", session.idToken)
    target = url.toString()
  }

  const res = NextResponse.json({ ok: true, url: target })
  clearSessionCookies(res, request, authUrl)
  return res
}
