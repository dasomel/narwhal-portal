// NextAuth session-cookie naming, shared by the middleware gate (src/proxy.ts)
// and federated logout. Kept free of next-auth imports so the Edge middleware
// bundle stays lean. The session JWE always exceeds 4KB (it carries Keycloak
// tokens), so NextAuth splits it into chunked cookies "<base>.0", "<base>.1", …
// and the base-named cookie does not exist; chunking always starts at ".0".
export const SESSION_COOKIE_BASES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const

// O(1) presence check: base name (unchunked) or first chunk.
export function hasSessionCookie(cookies: { has(name: string): boolean }): boolean {
  return SESSION_COOKIE_BASES.some((base) => cookies.has(base) || cookies.has(`${base}.0`))
}

// Matches any chunk ("<base>.<n>") of either base name.
export function isSessionCookieChunk(name: string): boolean {
  return SESSION_COOKIE_BASES.some((base) => name.startsWith(`${base}.`))
}
