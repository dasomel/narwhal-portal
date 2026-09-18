import { describe, expect, it, vi, beforeEach } from "vitest"

// portal#27: evaluateAll/evaluateService cached evaluations under keys that did
// not depend on the scorecard rules ConfigMap version, so an operator updating
// the ConfigMap kept getting evaluations computed under the OLD rules until the
// evaluation cache's own (shorter) TTL expired. See route.test.ts for the
// mocking rationale on getArgoApps/cacheGet.
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn(), getArgoApp: vi.fn() }
})

const { cacheGet } = await import("@/lib/valkey")
const { getArgoApps, getArgoApp } = await import("@/lib/argocd")
const { evaluateAll, evaluateService } = await import("@/lib/scorecard")

function configMapResponse(rulesYaml: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      metadata: { name: "narwhal-scorecard-rules", namespace: "devtools" },
      data: { "rules.yaml": rulesYaml },
    }),
  }
}

const rulesA = "version: 1\nrules: []\ntiers:\n  gold: 90\n  silver: 70\n  bronze: 50\n"
const rulesB = "version: 2\nrules: []\ntiers:\n  gold: 90\n  silver: 70\n  bronze: 50\n"

describe("evaluateAll — evaluation cache key includes the loaded rules version", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getArgoApps).mockResolvedValue([])
    // No cache hits anywhere, so both loadRules() and evaluateAll() always
    // recompute and we can observe the key each cacheGet call is made with.
    vi.mocked(cacheGet).mockResolvedValue(null)
  })

  it("uses a cache key derived from rules.version, and a different key once the ConfigMap version changes", async () => {
    global.fetch = vi.fn().mockResolvedValue(configMapResponse(rulesA))
    await evaluateAll()
    const keyForVersionA = vi.mocked(cacheGet).mock.calls.at(-1)?.[0]
    expect(keyForVersionA).toBe("scorecard:all:1:")

    global.fetch = vi.fn().mockResolvedValue(configMapResponse(rulesB))
    await evaluateAll()
    const keyForVersionB = vi.mocked(cacheGet).mock.calls.at(-1)?.[0]
    expect(keyForVersionB).toBe("scorecard:all:2:")

    // The discriminator: a stale version-A cache entry can no longer be
    // returned for a version-B rules load, because the keys differ.
    expect(keyForVersionB).not.toBe(keyForVersionA)
  })

  it("includes the tier filter alongside the rules version", async () => {
    global.fetch = vi.fn().mockResolvedValue(configMapResponse(rulesA))
    await evaluateAll("gold")
    const key = vi.mocked(cacheGet).mock.calls.at(-1)?.[0]
    expect(key).toBe("scorecard:all:1:gold")
  })
})

// portal#27: a K8s/ArgoCD query failure (network error, non-2xx) was silently
// coerced into "0 resources found" / "no pods found", making a genuine failure
// indistinguishable from an infra outage that prevented evaluation entirely.
// This is the same failure class as the #51 Prometheus / #32 DORA bugs (see
// docs/lessons-log.md): ambiguous data was silently normalized instead of
// surfaced as unavailable.
describe("evaluateService — source-unavailable evidence is not coerced into fail", () => {
  const rulesWithK8sCheck = [
    "version: 1",
    "rules:",
    "  - id: has-pdb",
    "    name: Has PodDisruptionBudget",
    "    weight: 100",
    "    check:",
    "      type: k8s-resource",
    "      kind: PodDisruptionBudget",
    "      minCount: 1",
    "tiers:",
    "  gold: 90",
    "  silver: 70",
    "  bronze: 50",
    "",
  ].join("\n")

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(getArgoApp).mockResolvedValue({
      metadata: { name: "svc-a", annotations: {} },
      spec: { destination: { namespace: "ns-a" } },
      status: { sync: { status: "Synced" }, health: { status: "Healthy" }, history: [] },
    } as never)
  })

  it("reports a K8s API failure as unavailable, not as a failed rule", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("configmaps")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            metadata: { name: "narwhal-scorecard-rules", namespace: "devtools" },
            data: { "rules.yaml": rulesWithK8sCheck },
          }),
        })
      }
      // PodDisruptionBudget list and pod list both fail (e.g. transient 500)
      return Promise.reject(new Error("connect ECONNREFUSED"))
    })

    const evaluation = await evaluateService("svc-a")

    expect(evaluation.failed).toEqual([])
    expect(evaluation.unavailable).toHaveLength(1)
    expect(evaluation.unavailable[0]).toMatchObject({ ruleId: "has-pdb" })
    expect(evaluation.evaluationComplete).toBe(false)
    // Not silently scored as a pass either — no achieved weight for the check.
    expect(evaluation.score).toBe(0)
  })
})
