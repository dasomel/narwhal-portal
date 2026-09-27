import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }))
vi.mock("@/lib/i18n-client", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}))

import { useQuery } from "@tanstack/react-query"
import { RuntimeEventsFeed } from "./runtime-events-feed"

function renderFeed() {
  return renderToStaticMarkup(<RuntimeEventsFeed />)
}

describe("RuntimeEventsFeed data states", () => {
  it("shows unavailable instead of empty after a query failure", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    } as never)

    const html = renderFeed()
    expect(html).toContain("dataState.unavailable")
    expect(html).not.toContain("dataState.empty")
  })

  it("keeps events visible when a refresh fails", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: [{ id: "event-1", time: "2026-09-28T00:00:00.000Z", priority: "Warning", rule: "Unexpected shell", output: "shell started", source: "syscall", pod: "api-1" }],
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    } as never)

    const html = renderFeed()
    expect(html).toContain("Unexpected shell")
    expect(html).toContain("dataState.stale")
  })
})
