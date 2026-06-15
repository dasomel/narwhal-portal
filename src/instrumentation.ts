export async function register() {
  // H-8: AUTH_MOCK 운영 환경 차단 (부팅 시점 이중 가드)
  if (process.env.NODE_ENV === "production" && process.env.AUTH_MOCK === "true") {
    throw new Error("AUTH_MOCK is forbidden in production")
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.OTEL_ENABLED === "true") {
    // L-4: OTEL_EXPORTER_OTLP_ENDPOINT 미설정 시 처리
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://tempo.monitoring.svc.cluster.local:4318"

    if (!endpoint) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "[OTEL] OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true in production"
        )
      } else {
        console.warn(
          "[OTEL] OTEL_EXPORTER_OTLP_ENDPOINT is not set — OTEL disabled. " +
            "Set OTEL_EXPORTER_OTLP_ENDPOINT to enable tracing."
        )
        return
      }
    }

    const { NodeSDK, tracing, resources } = await import(
      "@opentelemetry/sdk-node"
    )
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    )
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
      "@opentelemetry/semantic-conventions"
    )
    const { getNodeAutoInstrumentations } = await import(
      "@opentelemetry/auto-instrumentations-node"
    )

    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    })

    const sdk = new NodeSDK({
      resource: resources.resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "idp-portal",
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
      }),
      spanProcessor: new tracing.BatchSpanProcessor(exporter),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    })

    try {
      sdk.start()
    } catch (err) {
      console.warn("[OTEL] SDK start failed:", err)
    }
  }
}
