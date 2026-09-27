import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }))
vi.mock("@/lib/i18n-client", () => ({ useT: () => (key: string) => key }))

import { useQuery } from "@tanstack/react-query"
import { ClusterInfraView } from "./cluster-infra-view"

const truncatedInfra = {
  nodes: [],
  controlPlane: [],
  namespaces: [],
  summary: { totalNodes: 1, readyNodes: 1, totalPods: 10, totalNamespaces: 1, truncated: true },
}

function queryResult(data: unknown, isError = false) {
  return { data, isLoading: false, isError, error: isError ? new Error("failed") : null, refetch: vi.fn() } as never
}

describe("ClusterInfraView data states", () => {
  it("shows an error state instead of empty after the API fails", () => {
    vi.mocked(useQuery).mockReturnValue(queryResult(undefined, true))
    const html = renderToStaticMarkup(<ClusterInfraView />)
    expect(html).toContain("dataState.error")
    expect(html).not.toContain("dataState.empty")
  })

  it("keeps summary data visible with a partial response banner", () => {
    vi.mocked(useQuery).mockReturnValue(queryResult(truncatedInfra))
    const html = renderToStaticMarkup(<ClusterInfraView />)
    expect(html).toContain("dataState.partial")
    expect(html).toContain("1/1")
    expect(html).toContain("10")
  })
})
