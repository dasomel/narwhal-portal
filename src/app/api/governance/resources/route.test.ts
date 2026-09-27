import { describe, expect, it, vi, beforeEach } from "vitest"
import type { NamespaceInfo, K8sRawPodMinimal } from "@/lib/k8s-client"
import type { VectorMetricResult, ClusterMetricsProjection } from "@/lib/prometheus"

// The route returned cluster-wide namespace/pod metrics under one unscoped cache key
// regardless of caller — no requireRole (contrast /api/governance/audit) and no
// getEffectiveScope filter (contrast /api/governance/scorecard, /api/governance/dora),
// even though nav.tsx gates /governance to cluster-admin/developer/viewer, not
// admin-only. See src/app/api/catalog/route.test.ts for the mocking rationale (auth
// mocked wholesale; @/lib/scope left real so this exercises real scope resolution).
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheGetWithMeta: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/prometheus", () => ({ queryVector: vi.fn(), getClusterMetrics: vi.fn() }))
vi.mock("@/lib/k8s-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/k8s-client")>()
  return { ...actual, getNamespaces: vi.fn(), getAllPodsMinimal: vi.fn() }
})

const { auth } = await import("@/lib/auth")
const { cacheGetWithMeta } = await import("@/lib/valkey")
const { queryVector, getClusterMetrics } = await import("@/lib/prometheus")
const { getNamespaces, getAllPodsMinimal } = await import("@/lib/k8s-client")
const { GET } = await import("./route")

const adminSession = { groups: ["cluster-admin"], teams: [], user: { role: "cluster-admin" } }
const frontendTeamSession = { groups: ["developer"], teams: ["frontend-team"], user: { role: "developer" } }

const namespaces: NamespaceInfo[] = [
  { name: "platform-system", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
  { name: "frontend-app", status: "Active", labels: {}, createdAt: "2026-01-01T00:00:00Z" },
]

const pods: K8sRawPodMinimal[] = [
  {
    metadata: { name: "platform-pod-1", namespace: "platform-system" },
    spec: { containers: [{ name: "web", resources: { requests: { cpu: "100m" } } }] }, // missing memory request
  },
  {
    metadata: { name: "frontend-pod-1", namespace: "frontend-app" },
    spec: { containers: [{ name: "web", resources: {} }] }, // missing both requests
  },
]

function vec(namespace: string, value: number, pod?: string): VectorMetricResult {
  return { metric: pod ? { namespace, pod } : { namespace }, value }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNamespaces).mockResolvedValue(namespaces)
  vi.mocked(getAllPodsMinimal).mockResolvedValue({ items: pods, truncated: false, pages: 1 })
  vi.mocked(getClusterMetrics).mockResolvedValue({
    status: "ok",
    source: "prometheus",
    evaluatedAt: "2026-09-27T00:00:00.000Z",
    cpu: 42,
    memory: 55,
    nodes: { total: 3, ready: 3, source: "prometheus", status: "ok" },
    pods: { total: 20, running: 18, source: "prometheus", status: "ok" },
    components: Object.fromEntries(
      ["cpu", "memory", "nodeCount", "nodeReady", "podCount", "podRunning"].map((k) => [
        k,
        { status: "ok", query: k, value: 1, source: "prometheus" },
      ]),
    ) as ClusterMetricsProjection["components"],
  })

  vi.mocked(queryVector).mockImplementation(async (promql: string) => {
    if (promql.includes("kube_pod_info")) {
      return [vec("platform-system", 5), vec("frontend-app", 3)]
    }
    if (promql.includes("namespace, pod")) {
      if (promql.includes("cpu_usage")) {
        return [vec("platform-system", 1.5, "platform-pod-1"), vec("frontend-app", 0.5, "frontend-pod-1")]
      }
      return [vec("platform-system", 1000, "platform-pod-1"), vec("frontend-app", 500, "frontend-pod-1")]
    }
    if (promql.includes("cpu_usage")) {
      return [vec("platform-system", 2), vec("frontend-app", 1)]
    }
    if (promql.includes('resource="cpu"')) {
      return [vec("platform-system", 4), vec("frontend-app", 2)]
    }
    if (promql.includes("memory_working_set")) {
      return [vec("platform-system", 100), vec("frontend-app", 50)]
    }
    if (promql.includes('resource="memory"')) {
      return [vec("platform-system", 200), vec("frontend-app", 100)]
    }
    return []
  })
})

describe("GET /api/governance/resources — scope enforcement", () => {
  it("does not leak another team's namespace, top pods, or cluster totals to an out-of-scope caller", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.freshness.source).toBe("live")

    const nsNames = body.namespaces.map((n: { namespace: string }) => n.namespace)
    expect(nsNames).toEqual(["frontend-app"])

    const topPodNames = [...body.topCpuPods, ...body.topMemPods].map((p: { pod: string }) => p.pod)
    expect(topPodNames).not.toContain("platform-pod-1")

    const noRequestNs = body.noRequestPodsList.map((p: { namespace: string }) => p.namespace)
    expect(noRequestNs).not.toContain("platform-system")

    // Mutation check: if the aggregate silently fell back to the cluster-wide
    // getClusterMetrics fixture (totalPods: 20) instead of summing only the caller's
    // visible namespace (frontend-app: 3 pods), this would still pass with a looser
    // "not equal to admin's number" assertion — assert the exact scoped value instead.
    expect(body.cluster.totalPods).toBe(3)
    expect(body.cluster.noRequestPods).toBe(1)
    // cpuPercent for a scoped caller means usage/requests over their own visible
    // namespaces, not usage/node-capacity like the admin's — the UI must label these
    // differently, so the response says which one this is.
    expect(body.cluster.basis).toBe("visible-requests")
  })

  it("cluster-admin retains full cluster visibility and totals", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    const nsNames = body.namespaces.map((n: { namespace: string }) => n.namespace)
    expect(nsNames).toEqual(expect.arrayContaining(["platform-system", "frontend-app"]))

    const topPodNames = [...body.topCpuPods, ...body.topMemPods].map((p: { pod: string }) => p.pod)
    expect(topPodNames).toContain("platform-pod-1")

    // Admin sees the genuinely cluster-wide totals from getClusterMetrics, unchanged.
    expect(body.cluster.totalPods).toBe(20)
    expect(body.cluster.cpuPercent).toBe(42)
    expect(body.cluster.noRequestPods).toBe(2)
    expect(body.cluster.basis).toBe("cluster-capacity")
  })

  it("reports the original capture time on a cached response", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    const cachedValue = {
      namespaces: [], topCpuPods: [], topMemPods: [],
      cluster: { cpuPercent: 1, memPercent: 2, totalPods: 3, noRequestPods: 0, basis: "cluster-capacity" },
      noRequestPodsList: [], freshness: { source: "live", observedAt: "2026-09-27T00:00:00.000Z" },
    }
    vi.mocked(cacheGetWithMeta).mockResolvedValueOnce({
      value: cachedValue as never, cachedAt: "2026-09-27T00:00:00.000Z", ageSeconds: 86_400,
    })

    const res = await GET()
    const body = await res.json()
    expect(body.freshness).toEqual({ source: "cache", observedAt: "2026-09-27T00:00:00.000Z" })
    expect(body.namespaces).toEqual(cachedValue.namespaces)
  })

  it("401s an unauthenticated caller", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await GET()
    expect(res.status).toBe(401)
    expect(getNamespaces).not.toHaveBeenCalled()
  })
})

// The `truncated` flag says the cluster-wide k8s API pod scan (getAllPodsMinimal) hit its
// page cap. Passing that raw flag through to a scoped caller would leak a fact about
// namespaces outside their scope (that the CLUSTER has enough pods to hit the cap). A
// per-namespace derived signal was tried and rejected (Codex review of 9d57c8e: false
// positives from Prometheus scrape lag / duplicate kube_pod_info series) — the field is
// simply omitted for scoped callers instead of reported, guessed, or defaulted.
describe("GET /api/governance/resources — truncated flag is scope-safe", () => {
  it("omits the truncated key entirely for a scoped caller, even when the cluster-wide scan was truncated", async () => {
    vi.mocked(auth).mockResolvedValue(frontendTeamSession as never)
    vi.mocked(getAllPodsMinimal).mockResolvedValue({ items: pods, truncated: true, pages: 5 })

    const res = await GET()
    const body = await res.json()
    // Mutation check: reverting to `truncated: allPodsResult.truncated` for everyone
    // would put a `true` here instead of omitting the key.
    expect("truncated" in body).toBe(false)
  })

  it("passes the raw cluster-wide flag through unchanged for cluster-admin", async () => {
    vi.mocked(auth).mockResolvedValue(adminSession as never)
    vi.mocked(getAllPodsMinimal).mockResolvedValue({ items: pods, truncated: true, pages: 5 })
    const res = await GET()
    const body = await res.json()
    expect(body.truncated).toBe(true)
  })
})
