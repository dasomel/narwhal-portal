import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"

// RP-initiated (federated) logout: clears the portal session AND ends the Keycloak
// SSO session via the end_session_endpoint. Without this, NextAuth signOut() only
// drops the local cookie while the Keycloak session survives, so the portal's
// auto-redirect silently logs the user straight back in.
export async function GET() {
  const session = await auth()
  const issuer = process.env.KEYCLOAK_ISSUER
  const authUrl = process.env.AUTH_URL ?? ""
  const postLogoutRedirect = `${authUrl}/login`

  let target = postLogoutRedirect
  if (issuer) {
    const url = new URL(`${issuer}/protocol/openid-connect/logout`)
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect)
    // Keycloak requires id_token_hint OR client_id to validate post_logout_redirect_uri.
    // Sessions created before id_token was persisted won't have it — client_id keeps
    // logout working as a fallback.
    const clientId = process.env.KEYCLOAK_CLIENT_ID
    if (clientId) url.searchParams.set("client_id", clientId)
    if (session?.idToken) url.searchParams.set("id_token_hint", session.idToken)
    target = url.toString()
  }

  const res = NextResponse.redirect(target)
  const isHttps = (authUrl || "").startsWith("https")
  // Expire every NextAuth cookie variant. __Secure-/__Host- prefixed cookies are
  // only cleared by the browser if the clearing Set-Cookie also carries Secure.
  const expire = (name: string, secure: boolean) =>
    res.cookies.set(name, "", { path: "/", expires: new Date(0), secure, httpOnly: true, sameSite: "lax" })
  expire("authjs.session-token", false)
  expire("authjs.callback-url", false)
  expire("authjs.csrf-token", false)
  if (isHttps) {
    expire("__Secure-authjs.session-token", true)
    expire("__Secure-authjs.callback-url", true)
    res.cookies.set("__Host-authjs.csrf-token", "", { path: "/", expires: new Date(0), secure: true, httpOnly: true, sameSite: "lax" })
  }
  return res
}
