import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface RouteErrorFallbackProps {
  error: Error & { digest?: string }
  onRetry: () => void
  title: string
  description: string
  retryLabel: string
  digestLabel: string
}

// Shared accessible fallback for route-level error boundaries (error.tsx / global-error.tsx).
// Presentational only (no i18n hook) so the caller controls both the copy and the retry
// wiring (Next's `retry()`/`reset()` prop, whichever the segment provides) and so this stays
// testable without a DOM (see route-error-fallback.test.tsx).
export function RouteErrorFallback({
  error,
  onRetry,
  title,
  description,
  retryLabel,
  digestLabel,
}: RouteErrorFallbackProps) {
  return (
    <div role="alert" className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <AlertTriangle aria-hidden="true" className="mx-auto mb-2 size-8 text-narwhal-danger" />
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              {digestLabel}: {error.digest}
            </p>
          ) : null}
          <Button onClick={onRetry}>{retryLabel}</Button>
        </CardContent>
      </Card>
    </div>
  )
}
