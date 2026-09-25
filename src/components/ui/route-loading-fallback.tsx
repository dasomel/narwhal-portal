interface RouteLoadingFallbackProps {
  label: string
}

// Shared accessible fallback for route-level loading.tsx files. No hooks/interactivity, so it
// renders fine from a Server Component; the spinner is decorative (aria-hidden) and the status
// text is announced to screen readers via the sr-only span, per issue #62's "status must not
// rely on color alone" requirement (icon + text, here text-only since there's no color signal).
export function RouteLoadingFallback({ label }: RouteLoadingFallbackProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-[50vh] items-center justify-center gap-3 p-6"
    >
      <div
        aria-hidden="true"
        className="h-8 w-8 rounded-full border-2 border-border border-t-narwhal-accent animate-spin"
      />
      <span className="sr-only">{label}</span>
    </div>
  )
}
