import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./valkey", () => ({ cacheGet: vi.fn(async () => null), cacheSet: vi.fn() }))
vi.mock("./argocd", () => ({ getArgoApps: vi.fn(async () => []) }))

import { getServiceGraph } from "./service-graph"

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SERVICE_GRAPH_SOURCE
})

describe("service graph Prometheus transport", () => {
  it.each([429, 503])("does not retry Prometheus %s responses", async (status) => {
    process.env.SERVICE_GRAPH_SOURCE = "istio"
    const fetchSpy = vi.fn(async () => Response.json({}, { status }))
    vi.stubGlobal("fetch", fetchSpy)

    const graph = await getServiceGraph("1h")

    expect(graph.edges).toEqual([])
    expect(graph.notice).toContain("Prometheus 미응답")
    // Three L7 queries and one TCP query each get one attempt.
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })
})
