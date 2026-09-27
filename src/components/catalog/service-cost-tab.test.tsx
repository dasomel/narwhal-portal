import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }))
vi.mock("@/lib/i18n-client", () => ({ useT: () => (key: string) => key }))
vi.mock("recharts", () => {
  const Component = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    CartesianGrid: Component,
    Line: Component,
    LineChart: Component,
    ResponsiveContainer: Component,
    Tooltip: Component,
    XAxis: Component,
    YAxis: Component,
  }
})

import { useQuery } from "@tanstack/react-query"
import { ServiceCostTab } from "./service-cost-tab"

const detail = {
  serviceId: "svc-1",
  generatedAt: "2026-09-28T00:00:00.000Z",
  unitPrices: { cpuHourly: 1, memGbHourly: 1, storageGbHourly: 1 },
  id: "svc-1",
  cpu: { cores: 1, hourly: 4 },
  memory: { gb: 2, hourly: 3 },
  storage: { gb: 1, hourly: 1 },
  totalHourly: 42,
  totalMonthly: 42 * 730,
  topPods: [],
  telemetry: { state: "partial" as const },
}

function queryResult(data: unknown, isError = false) {
  return { data, isLoading: false, isError, error: isError ? new Error("failed") : null, refetch: vi.fn() } as never
}

describe("ServiceCostTab data states", () => {
  it("shows unavailable instead of empty after the detail API fails", () => {
    vi.mocked(useQuery)
      .mockReturnValueOnce(queryResult(undefined, true))
      .mockReturnValueOnce(queryResult(undefined))
    const html = renderToStaticMarkup(<ServiceCostTab serviceId="svc-1" />)
    expect(html).toContain("dataState.unavailable")
    expect(html).not.toContain("dataState.empty")
  })

  it("keeps cost values visible with partial telemetry", () => {
    vi.mocked(useQuery)
      .mockReturnValueOnce(queryResult(detail))
      .mockReturnValueOnce(queryResult({ scope: "service", id: "svc-1", days: 7, points: [], telemetry: { state: "ok" } }))
    const html = renderToStaticMarkup(<ServiceCostTab serviceId="svc-1" />)
    expect(html).toContain("dataState.partial")
    expect(html).toContain("$42.0000")
    expect(html).toContain("$30660.00")
  })
})
