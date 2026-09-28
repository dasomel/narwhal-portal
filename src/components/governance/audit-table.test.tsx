import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }))
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { role: "cluster-admin" } } }) }))
vi.mock("@/lib/i18n-client", () => ({ useT: () => (key: string) => key, useLocale: () => "en" }))
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}))

import { useQuery } from "@tanstack/react-query"
import { AuditTable } from "./audit-table"

describe("Operational Events truncation state", () => {
  it("shows a partial-data notice for a truncated result", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { items: [], truncated: true, evidenceKind: "operational-event", freshness: { source: "live", observedAt: null } },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as never)

    const html = renderToStaticMarkup(<AuditTable />)
    expect(html).toContain("opEvents.truncatedNotice")
    expect(html).toContain("dataState.partial")
  })
})
