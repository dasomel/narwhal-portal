import type { NextConfig } from "next"

// 환경변수에서 origin 추출 유틸
function extractOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const { origin } = new URL(url)
    return origin
  } catch {
    return null
  }
}

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
]

// 이미지 도메인 allowlist — 환경변수 기반
type ImageDomain = { protocol: string; hostname: string; port: string | undefined }

const imageDomains: ImageDomain[] = [
  process.env.KEYCLOAK_URL,
]
  .map(extractOrigin)
  .filter((o): o is string => o !== null)
  .reduce<ImageDomain[]>((acc, origin) => {
    try {
      const { hostname, port, protocol } = new URL(origin)
      acc.push({ protocol, hostname, port: port || undefined })
    } catch {
      // 파싱 실패 시 생략
    }
    return acc
  }, [])

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // skaffold dev(라이브 HMR): APISIX 게이트웨이 도메인 경유 접근 시 Next 16이
  // /_next/* dev 리소스를 cross-origin으로 차단 → 대시보드/세션 UI 깨짐. dev 전용 허용.
  allowedDevOrigins: ["portal.local.narwhal.internal"],
  serverExternalPackages: [
    "@kubernetes/client-node",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/semantic-conventions",
    "@grpc/grpc-js",
    "@grpc/proto-loader",
  ],
  // hubble-relay gRPC용 proto 파일 — standalone 빌드 추적에 포함 (런타임 loadSync)
  outputFileTracingIncludes: {
    "/api/service-graph/stream": ["./protos/**/*"],
  },
  // sharp/libvips를 standalone 산출물에서 제외 — 아래 images.unoptimized 주석 참고.
  // unoptimized만으로는 빠지지 않는다(Next가 optimizer 사용 여부와 무관하게 추적함).
  // 제외 후 standalone 서버를 실제로 기동해 라우트 응답까지 확인했다.
  outputFileTracingExcludes: {
    "*": ["node_modules/sharp/**", "node_modules/@img/**", "node_modules/.pnpm/@img+*/**", "node_modules/.pnpm/sharp@*/**"],
  },
  images: {
    // 최적화 비활성 — libvips(LGPL-3.0-or-later) 재배포를 피하기 위함.
    //
    // Next는 image optimizer용으로 sharp를 standalone 추적에 자동 포함한다.
    // sharp의 네이티브 백엔드 @img/sharp-libvips-*는 LGPL-3.0-or-later라서
    // 이미지에 담기는 순간 전문 첨부 + 소스 입수 경로 + 재링크 고지 의무가
    // 붙는다. 그런데 src 전체에 next/image import가 0건이라 optimizer는
    // 한 번도 쓰인 적이 없다. 쓰지도 않는 기능 때문에 copyleft 의무를 지는
    // 상황이므로 끈다.
    //
    // 되돌리려면: 이 줄을 지우고 THIRD-PARTY-NOTICES.md를 재생성한 뒤,
    // NOTICE의 sharp/libvips 항목을 "제외됨"에서 실제 고지로 바꿔야 한다.
    // remotePatterns는 그때를 위해 남겨둔다 (unoptimized일 때는 무시됨).
    unoptimized: true,
    remotePatterns: imageDomains.map(({ protocol, hostname, port }) => ({
      protocol: protocol.replace(":", "") as "http" | "https",
      hostname,
      ...(port ? { port } : {}),
    })),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
