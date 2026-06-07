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
    if (session?.idToken) url.searchParams.set("id_token_hint", session.idToken)
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect)
    target = url.toString()
  }

  const res = NextResponse.redirect(target)
  // Expire every NextAuth cookie variant (secure/non-secure + csrf + callback).
  for (const name of [
    "authjs.session-token",
    "__Secure-authjs.session-token",
    "authjs.csrf-token",
    "__Host-authjs.csrf-token",
    "authjs.callback-url",
    "__Secure-authjs.callback-url",
  ]) {
    res.cookies.set(name, "", { path: "/", expires: new Date(0) })
  }
  return res
}
