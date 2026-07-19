"use client"
import { SessionProvider } from "next-auth/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { useState } from "react"
import { LocaleProvider } from "@/lib/i18n-client"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Locale } from "@/lib/i18n"

export function Providers({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchInterval: 30_000,
            retry: 2,
          },
        },
      })
  )
  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <LocaleProvider locale={locale}>
          <TooltipProvider>
            {children}
            {process.env.NODE_ENV === "development" && (
              <ReactQueryDevtools initialIsOpen={false} />
            )}
          </TooltipProvider>
        </LocaleProvider>
      </QueryClientProvider>
    </SessionProvider>
  )
}
