"use client" // Error boundaries must be Client Components

import { useEffect } from "react"

import { RouteErrorFallback } from "@/components/ui/route-error-fallback"
import { useT } from "@/lib/i18n-client"

// Settings is a critical surface (cluster-admin only): a provider outage here must not
// render as a blank page (issue #62).
export default function SettingsError({
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
