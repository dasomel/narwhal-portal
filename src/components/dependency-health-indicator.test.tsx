import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LocaleProvider } from "@/lib/i18n-client"
import { DependencyHealthIndicator } from "./dependency-health-indicator"

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return { ...actual, useQuery: vi.fn() }
})

import { useQuery } from "@tanstack/react-query"

describe("DependencyHealthIndicator", () => {
  it.each([
    { queryState: { isLoading: true } },
    { queryState: { isError: true, error: new Error("offline") } },
  ])("renders null for loading and error states", ({ queryState }) => {
    vi.mocked(useQuery).mockReturnValue(queryState as never)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LocaleProvider locale="en"><DependencyHealthIndicator /></LocaleProvider>
      </QueryClientProvider>,
    )
    expect(html).toBe("")
  })

  it.each([
    ["ok", "All systems normal"],
    ["degraded", "Degraded"],
    ["unavailable", "Unavailable"],
  ] as const)("renders %s with an accessible text status", (state, label) => {
    vi.mocked(useQuery).mockReturnValue({ data: { state, observedAt: "2026-09-28T00:00:00.000Z" } } as never)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <LocaleProvider locale="en"><DependencyHealthIndicator /></LocaleProvider>
      </QueryClientProvider>,
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain(label)
  })
})
