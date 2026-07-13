import { NextResponse, type NextRequest } from "next/server"

import { hasSessionCookie } from "@/lib/session-cookie"

// connect-src 외부 origin (런타임 env 기반, 모듈 1회 계산)
function extractOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const externalOrigins = [
  process.env.KEYCLOAK_URL,
  process.env.ARGOCD_URL,
  process.env.PROMETHEUS_URL,
  process.env.ALERTMANAGER_URL,
  process.env.OPENBAO_ADDR ?? process.env.OPENBAO_URL,
  process.env.LOKI_URL,
  process.env.APISIX_ADMIN_URL,
]
  .map(extractOrigin)
  .filter((o): o is string => o !== null)

const connectSrc = ["'self'", ...new Set(externalOrigins)].join(" ")

export function proxy(request: NextRequest) {
  // Gate page routes behind a session: an unauthenticated visitor must not reach
  // the dashboard ("/"), whose client widgets fetch /api/* → 401 and crash the
  // React tree (white "couldn't load" screen). Redirect to /login first so the
  // dashboard never renders without a session. Token validity is still verified
  // by auth() in pages and API routes; this only checks cookie presence (Edge-safe).
  // Checking only the base cookie names sent every login into a redirect loop:
  // the chunked session cookie (see session-cookie.ts) meant the base name
  // never exists → this gate missed it → /login → SSO → loop.
  const hasSession = hasSessionCookie(request.cookies)
  if (!hasSession && !request.nextUrl.pathname.startsWith("/login")) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    const dest = request.nextUrl.pathname + request.nextUrl.search
    url.search = `?callbackUrl=${encodeURIComponent(dest)}`
    return NextResponse.redirect(url)
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const isDev = process.env.NODE_ENV === "development"

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // 로컬 http 개발 환경 깨짐 방지: 프로덕션에서만 https 업그레이드 강제
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ")

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", csp)
  return response
}

export const config = {
  matcher: [
    {
      // `_next` 전체 제외: dev HMR 웹소켓(/_next/webpack-hmr)이 매처에 걸리면
      // 로그인 307로 업그레이드가 깨져 라이브 모드 클라이언트가 동작하지 않는다.
      source: "/((?!api|_next|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
