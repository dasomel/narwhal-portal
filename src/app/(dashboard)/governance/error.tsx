"use client" // Error boundaries must be Client Components

import { useEffect } from "react"

import { RouteErrorFallback } from "@/components/ui/route-error-fallback"
import { useT } from "@/lib/i18n-client"

// Governance surfaces scorecards/RBAC/audit data pulled from cluster providers; an outage
// there must not render as a blank page (issue #62).
export default function GovernanceError({
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
