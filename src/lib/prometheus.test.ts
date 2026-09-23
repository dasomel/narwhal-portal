import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCache = new Map<string, unknown>()
vi.mock("./valkey", () => ({
  cacheGet: vi.fn(async (key: string) => mockCache.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, val: unknown) => {
    mockCache.set(key, val)
  }),
}))

vi.mock("./config", () => ({
  getK8sApiServer: () => "http://k8s.mock",
  getDependencyUrl: (_name: string, fallback: string) => fallback,
}))

import {
  queryScalarExplicit,
  queryVectorExplicit,
  queryRangeExplicit,
  getNodeMetrics,
  getClusterMetrics,
  getNodePodCountExplicit,
  getNodePodCount,
  matchSeriesForNode,
  type VectorMetricResult,
  STALENESS_THRESHOLD_SECONDS,
} from "./prometheus"

describe("Prometheus Telemetry Semantics & Projections (Issue #51)", () => {
  beforeEach(() => {
    mockCache.clear()
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------------
  // Deterministic Fixtures
  // ---------------------------------------------------------------------------
  const FIXTURE_EMPTY_VECTOR = {
    status: "success",
    data: { resultType: "vector", result: [] },
  }

  const FIXTURE_SINGLE_ZERO = {
    status: "success",
    data: {
      resultType: "vector",
      result: [{ metric: { __name__: "cpu_idle" }, value: [Math.floor(Date.now() / 1000), "0"] }],
    },
  }

  const FIXTURE_SINGLE_SCALAR = (val: string, tsSec = Math.floor(Date.now() / 1000)) => ({
    status: "success",
    data: {
      resultType: "vector",
      result: [{ metric: { __name__: "metric" }, value: [tsSec, val] }],
    },
  })

  const FIXTURE_MULTI_SERIES = {
    status: "success",
    data: {
      resultType: "vector",
      result: [
        { metric: { instance: "node-1" }, value: [Math.floor(Date.now() / 1000), "45"] },
        { metric: { instance: "node-2" }, value: [Math.floor(Date.now() / 1000), "55"] },
      ],
    },
  }

  // ---------------------------------------------------------------------------
  // 1. Telemetry failure vs healthy zero distinction
  // ---------------------------------------------------------------------------
  describe("Distinguishing failure from healthy zero", () => {
    it("reports 'unavailable' on network / exporter error, never zero", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Connection refused to Prometheus"))
      )

      const res = await queryScalarExplicit("count(kube_node_info)")
      expect(res.status).toBe("unavailable")
      expect(res.value).toBeNull()
      expect(res.error).toContain("Connection refused")
    })

    it("reports 'unavailable' on HTTP 500 / 503 response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        })
      )

      const res = await queryScalarExplicit("count(kube_node_info)")
      expect(res.status).toBe("unavailable")
      expect(res.value).toBeNull()
      expect(res.error).toContain("503")
    })

    it("reports 'empty' when query returns 0 matching series, never zero", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_EMPTY_VECTOR,
        })
      )

      const res = await queryScalarExplicit("count(kube_node_info)")
      expect(res.status).toBe("empty")
      expect(res.value).toBeNull()
      expect(res.seriesCount).toBe(0)
    })

    it("preserves authentic zero value as status 'ok'", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_SINGLE_ZERO,
        })
      )

      const res = await queryScalarExplicit("sum(rate(container_errors[5m]))")
      expect(res.status).toBe("ok")
      expect(res.value).toBe(0)
      expect(res.seriesCount).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // 2. Ambiguous multi-series scalar queries
  // ---------------------------------------------------------------------------
  describe("Ambiguous multi-series queries", () => {
    it("rejects multi-series scalar results as ambiguous unless explicitly allowed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_MULTI_SERIES,
        })
      )

      const res = await queryScalarExplicit("node_cpu_seconds_total")
      expect(res.status).toBe("ambiguous")
      expect(res.value).toBeNull()
      expect(res.seriesCount).toBe(2)
      expect(res.error).toContain("Ambiguous scalar query returned 2 series")
    })

    it("allows multi-series scalar when explicitly permitted with allowMultiSeries: true", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_MULTI_SERIES,
        })
      )

      const res = await queryScalarExplicit("node_cpu_seconds_total", { allowMultiSeries: true })
      expect(res.status).toBe("ok")
      expect(res.value).toBe(45)
    })

    it("marks multi-series range queries as ambiguous", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              resultType: "matrix",
              result: [
                { metric: { instance: "a" }, values: [[1000, "10"], [1060, "11"]] },
                { metric: { instance: "b" }, values: [[1000, "20"], [1060, "21"]] },
              ],
            },
          }),
        })
      )

      const res = await queryRangeExplicit("rate(http_requests[5m])")
      expect(res.status).toBe("ambiguous")
      expect(res.seriesCount).toBe(2)
      expect(res.data).toHaveLength(2)
    })
  })

  // ---------------------------------------------------------------------------
  // 3. Stale data & NaN detection
  // ---------------------------------------------------------------------------
  describe("Stale data & NaN semantics", () => {
    it("flags data older than staleness threshold as 'stale'", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const staleTimestamp = nowSec - (STALENESS_THRESHOLD_SECONDS + 60)

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_SINGLE_SCALAR("88", staleTimestamp),
        })
      )

      const res = await queryScalarExplicit("up{job='node-exporter'}")
      expect(res.status).toBe("stale")
      expect(res.value).toBe(88)
      expect(res.warning).toContain("stale by")
    })

    it("flags NaN values as 'stale' with null value", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => FIXTURE_SINGLE_SCALAR("NaN"),
        })
      )

      const res = await queryScalarExplicit("irate(nonexistent[1m])")
      expect(res.status).toBe("stale")
      expect(res.value).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // 4. Deterministic Canonical Node Identity Matching
  // ---------------------------------------------------------------------------
  describe("matchSeriesForNode (Canonical Node Identity)", () => {
    const seriesList: VectorMetricResult[] = [
      { metric: { node: "k8s-node-1" }, value: 4 },
      { metric: { nodename: "k8s-node-2" }, value: 8 },
      { metric: { instance: "k8s-node-3:9100" }, value: 16 },
      { metric: { instance: "192.168.1.10:9100" }, value: 32 },
      { metric: { instance: "192.168.1.100:9100" }, value: 64 },
    ]

    it("matches node directly via metric.node", () => {
      const match = matchSeriesForNode(seriesList, "k8s-node-1")
      expect(match.matched).toBe(true)
      if (match.matched) expect(match.value).toBe(4)
    })

    it("matches node directly via metric.nodename", () => {
      const match = matchSeriesForNode(seriesList, "k8s-node-2")
      expect(match.matched).toBe(true)
      if (match.matched) expect(match.value).toBe(8)
    })

    it("matches node via instance label with port", () => {
      const match = matchSeriesForNode(seriesList, "k8s-node-3")
      expect(match.matched).toBe(true)
      if (match.matched) expect(match.value).toBe(16)
    })

    it("matches node via exact internal IP and avoids partial prefix collision", () => {
      // 192.168.1.10 must NOT match 192.168.1.100
      const match10 = matchSeriesForNode(seriesList, "arbitrary-node", "192.168.1.10")
      expect(match10.matched).toBe(true)
      if (match10.matched) expect(match10.value).toBe(32)

      const match100 = matchSeriesForNode(seriesList, "another-node", "192.168.1.100")
      expect(match100.matched).toBe(true)
      if (match100.matched) expect(match100.value).toBe(64)
    })

    it("detects ambiguous multi-series matching the same node", () => {
      const ambiguousSeries: VectorMetricResult[] = [
        { metric: { node: "duplicate-node" }, value: 10 },
        { metric: { node: "duplicate-node" }, value: 20 },
      ]
      const match = matchSeriesForNode(ambiguousSeries, "duplicate-node")
      expect(match.matched).toBe(false)
      if (!match.matched) expect(match.reason).toBe("ambiguous")
    })

    it("returns not_found when no series match the node", () => {
      const match = matchSeriesForNode(seriesList, "nonexistent-node", "10.99.99.99")
      expect(match.matched).toBe(false)
      if (!match.matched) expect(match.reason).toBe("not_found")
    })
  })

  // ---------------------------------------------------------------------------
  // 5. getNodeMetrics semantics
  // ---------------------------------------------------------------------------
  describe("getNodeMetrics projection", () => {
    it("preserves null usagePercent and explicit status when metrics fail", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes("kube_node_info")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { node: "worker-1", internal_ip: "10.0.0.1" }, value: [1000, "1"] }],
                },
              }),
            }
          }
          if (url.includes("kube_node_role")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { node: "worker-1", role: "worker" }, value: [1000, "1"] }],
                },
              }),
            }
          }
          // Node exporter queries fail or return empty
          return {
            ok: false,
            status: 503,
          }
        })
      )

      const nodes = await getNodeMetrics()
      expect(nodes).toHaveLength(1)
      const n = nodes[0]
      expect(n.node).toBe("worker-1")
      expect(n.cpu.usagePercent).toBeNull()
      expect(n.cpu.status).toBe("unavailable")
      expect(n.memory.usagePercent).toBeNull()
      expect(n.memory.status).toBe("unavailable")
      expect(n.disk.usagePercent).toBeNull()
      expect(n.disk.status).toBe("unavailable")
      expect(n.status).toBe("unavailable")
    })

    it("reports real 0% usage as ok rather than unavailable", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes("kube_node_info")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { node: "idle-node", internal_ip: "10.0.0.2" }, value: [nowSec, "1"] }],
                },
              }),
            }
          }
          if (url.includes("kube_node_role")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { node: "idle-node", role: "worker" }, value: [nowSec, "1"] }],
                },
              }),
            }
          }
          if (url.includes("capacity")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { node: "idle-node" }, value: [nowSec, "8"] }],
                },
              }),
            }
          }
          if (url.includes("node_cpu_seconds_total")) {
            // idle CPU: 0% usage
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { instance: "10.0.0.2:9100" }, value: [nowSec, "0"] }],
                },
              }),
            }
          }
          if (url.includes("MemAvailable_bytes")) {
            // 25% memory usage
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { instance: "10.0.0.2:9100" }, value: [nowSec, "25"] }],
                },
              }),
            }
          }
          if (url.includes("MemTotal_bytes")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { instance: "10.0.0.2:9100" }, value: [nowSec, "16000000000"] }],
                },
              }),
            }
          }
          if (url.includes("node_filesystem_avail_bytes")) {
            // disk usage: 50%
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { instance: "10.0.0.2:9100" }, value: [nowSec, "50"] }],
                },
              }),
            }
          }
          if (url.includes("node_filesystem_size_bytes")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: {
                  resultType: "vector",
                  result: [{ metric: { instance: "10.0.0.2:9100" }, value: [nowSec, "100000000000"] }],
                },
              }),
            }
          }
          return { ok: false, status: 404 }
        })
      )

      const nodes = await getNodeMetrics()
      expect(nodes).toHaveLength(1)
      const n = nodes[0]
      expect(n.cpu.usagePercent).toBe(0)
      expect(n.cpu.status).toBe("ok")
      expect(n.memory.usagePercent).toBe(25)
      expect(n.memory.status).toBe("ok")
      expect(n.disk.usagePercent).toBe(50)
      expect(n.disk.status).toBe("ok")
      expect(n.status).toBe("ok")
    })
  })

  // ---------------------------------------------------------------------------
  // 6. getClusterMetrics & K8s Fallback
  // ---------------------------------------------------------------------------
  describe("getClusterMetrics evidence & fallback", () => {
    it("reports Prometheus source and full component status when all queries succeed", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          return {
            ok: true,
            json: async () => ({
              status: "success",
              data: {
                resultType: "vector",
                result: [{ metric: {}, value: [nowSec, "42"] }],
              },
            }),
          }
        })
      )

      const cluster = await getClusterMetrics()
      expect(cluster.status).toBe("ok")
      expect(cluster.source).toBe("prometheus")
      expect(cluster.cpu).toBe(42)
      expect(cluster.memory).toBe(42)
      expect(cluster.nodes.total).toBe(42)
      expect(cluster.nodes.source).toBe("prometheus")
      expect(cluster.pods.source).toBe("prometheus")
      expect(cluster.components.cpu.status).toBe("ok")
    })

    it("makes Prometheus→Kubernetes fallback visible as a different source", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          // CPU & Memory succeed in Prometheus
          if (url.includes("node_cpu_seconds_total")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: { resultType: "vector", result: [{ metric: {}, value: [nowSec, "15"] }] },
              }),
            }
          }
          if (url.includes("node_memory_MemAvailable_bytes")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: { resultType: "vector", result: [{ metric: {}, value: [nowSec, "30"] }] },
              }),
            }
          }
          // kube-state-metrics queries are empty / down
          if (url.includes("kube_node_info") || url.includes("kube_pod_info") || url.includes("kube_node_status") || url.includes("kube_pod_status")) {
            return {
              ok: true,
              json: async () => FIXTURE_EMPTY_VECTOR,
            }
          }
          // K8s API fallback mock
          if (url.includes("/api/v1/nodes")) {
            return {
              ok: true,
              json: async () => ({
                items: [
                  { status: { conditions: [{ type: "Ready", status: "True" }] } },
                  { status: { conditions: [{ type: "Ready", status: "True" }] } },
                  { status: { conditions: [{ type: "Ready", status: "False" }] } },
                ],
              }),
            }
          }
          if (url.includes("/api/v1/pods")) {
            return {
              ok: true,
              json: async () => ({
                items: [
                  { status: { phase: "Running" } },
                  { status: { phase: "Pending" } },
                ],
              }),
            }
          }
          return { ok: false, status: 404 }
        })
      )

      const cluster = await getClusterMetrics()
      expect(cluster.source).toBe("mixed")
      expect(cluster.nodes.source).toBe("kubernetes")
      expect(cluster.pods.source).toBe("kubernetes")
      expect(cluster.nodes.total).toBe(3)
      expect(cluster.nodes.ready).toBe(2)
      expect(cluster.pods.total).toBe(2)
      expect(cluster.pods.running).toBe(1)
      expect(cluster.cpu).toBe(15)
      expect(cluster.memory).toBe(30)
      expect(cluster.components.nodeCount.source).toBe("kubernetes")
      expect(cluster.components.podCount.source).toBe("kubernetes")
    })

    it("sets status to partial when some queries fail and no fallback is possible", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          // CPU succeeds
          if (url.includes("node_cpu_seconds_total")) {
            return {
              ok: true,
              json: async () => ({
                status: "success",
                data: { resultType: "vector", result: [{ metric: {}, value: [nowSec, "20"] }] },
              }),
            }
          }
          // Memory and K8s API fail
          return {
            ok: false,
            status: 500,
            statusText: "Internal Error",
          }
        })
      )

      const cluster = await getClusterMetrics()
      expect(cluster.status).toBe("partial")
      expect(cluster.cpu).toBe(20)
      expect(cluster.memory).toBeNull()
      expect(cluster.nodes.total).toBeNull()
      expect(cluster.pods.total).toBeNull()
      expect(cluster.components.cpu.status).toBe("ok")
      expect(cluster.components.memory.status).toBe("unavailable")
    })
  })

  // ---------------------------------------------------------------------------
  // 7. getNodePodCount
  // ---------------------------------------------------------------------------
  describe("getNodePodCount", () => {
    it("returns null on Prometheus failure, not zero", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Telemetry unavailable"))
      )

      const count = await getNodePodCount("worker-1")
      expect(count).toBeNull()

      const explicit = await getNodePodCountExplicit("worker-1")
      expect(explicit.status).toBe("unavailable")
      expect(explicit.value).toBeNull()
    })

    it("returns authentic 0 when node has zero pods and Prometheus is healthy", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            status: "success",
            data: { resultType: "vector", result: [{ metric: {}, value: [nowSec, "0"] }] },
          }),
        })
      )

      const count = await getNodePodCount("empty-node")
      expect(count).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Cluster-scoping in cache keys
  // ---------------------------------------------------------------------------
  describe("Cluster cache scoping", () => {
    it("isolates cache by clusterId", async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      let fetchCallCount = 0
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => {
          fetchCallCount++
          return {
            ok: true,
            json: async () => ({
              status: "success",
              data: { resultType: "vector", result: [{ metric: {}, value: [nowSec, `${fetchCallCount * 10}`] }] },
            }),
          }
        })
      )

      const res1 = await queryScalarExplicit("count(up)", { clusterId: "cluster-a" })
      expect(res1.value).toBe(10)

      const res2 = await queryScalarExplicit("count(up)", { clusterId: "cluster-b" })
      expect(res2.value).toBe(20)

      // Cached query for cluster-a should return 10 without fetching
      const res1Cached = await queryScalarExplicit("count(up)", { clusterId: "cluster-a" })
      expect(res1Cached.value).toBe(10)
      expect(fetchCallCount).toBe(2)
    })
  })
})
