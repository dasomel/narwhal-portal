import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

import { LocaleProvider } from "@/lib/i18n-client"
import { AlertsWidget } from "@/components/dashboard/alerts-widget"
import { SortableHeader } from "@/components/security/vulnerabilities-table"

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [{ labels: { alertname: "DiskFull", severity: "critical" }, annotations: {} }],
    isLoading: false,
  }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: "developer" } } }),
}))

describe("accessible table and alert controls", () => {
  it("places the sort button inside a header carrying aria-sort", () => {
    const html = renderToStaticMarkup(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Namespace" sortKey="namespace" current="namespace" dir="asc" onSort={vi.fn()} />
          </tr>
        </thead>
      </table>,
    )

    expect(html).toMatch(/<th aria-sort="ascending"[^>]*><button type="button"/)
  })

  it("renders Silence as a sibling of the alert detail button", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AlertsWidget />
      </LocaleProvider>,
    )
    const alertItem = html.match(/<li[^>]*>([\s\S]*?)<\/li>/)?.[1] ?? ""
    const detailClose = alertItem.indexOf("</button>")
    const silenceOpen = alertItem.indexOf("<button", detailClose + 1)

    expect(detailClose).toBeGreaterThan(-1)
    expect(silenceOpen).toBeGreaterThan(detailClose)
  })
})
