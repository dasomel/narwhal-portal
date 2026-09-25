"use client" // Error boundaries must be Client Components

import { useEffect } from "react"

import { RouteErrorFallback } from "@/components/ui/route-error-fallback"
import { useT } from "@/lib/i18n-client"

// Segment-level error boundary for the whole (dashboard) route group. Catches uncaught
// rendering errors for the main dashboard page and any nested route that doesn't define its
// own error.tsx, so a provider outage renders this fallback instead of a blank page (issue #62).
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const t = useT()

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <RouteErrorFallback
      error={error}
      onRetry={retry}
      title={t("routeState.error.title")}
      description={t("routeState.error.description")}
      retryLabel={t("routeState.error.retry")}
      digestLabel={t("routeState.error.digestLabel")}
    />
  )
}
