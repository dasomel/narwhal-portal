"use client" // Error boundaries must be Client Components

import { useEffect, useState } from "react"

import "./globals.css"
import { RouteErrorFallback } from "@/components/ui/route-error-fallback"
import { getLocaleFromCookie, t } from "@/lib/i18n"

function readLocaleCookie(): string | undefined {
  if (typeof document === "undefined") return undefined
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith("locale="))
    ?.split("=")[1]
}

// Root-level error boundary: catches errors the root layout itself throws, which no nested
// error.tsx can (issue #62). This replaces the root layout entirely, so it defines its own
// html/body and re-imports globals.css, and cannot use LocaleProvider/useT (no Providers tree
// above it) — the locale cookie is read directly instead, same value getLocaleFromCookie
// derives server-side in i18n-server.ts.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const [locale] = useState(() => getLocaleFromCookie(readLocaleCookie()))

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang={locale}>
      <body>
        <RouteErrorFallback
          error={error}
          onRetry={retry}
          title={t(locale, "routeState.error.title")}
          description={t(locale, "routeState.error.description")}
          retryLabel={t(locale, "routeState.error.retry")}
          digestLabel={t(locale, "routeState.error.digestLabel")}
        />
      </body>
    </html>
  )
}
