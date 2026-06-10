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
  allowedDevOrigins: ["portal.local.narwhal.io"],
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
  images: {
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
