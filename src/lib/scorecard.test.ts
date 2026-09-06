import { describe, expect, it, vi, beforeEach } from "vitest"

// portal#27: evaluateAll/evaluateService cached evaluations under keys that did
// not depend on the scorecard rules ConfigMap version, so an operator updating
// the ConfigMap kept getting evaluations computed under the OLD rules until the
// evaluation cache's own (shorter) TTL expired. See route.test.ts for the
// mocking rationale on getArgoApps/cacheGet.
vi.mock("@/lib/valkey", () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock("@/lib/argocd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/argocd")>()
  return { ...actual, getArgoApps: vi.fn() }
})

const { cacheGet } = await import("@/lib/valkey")
const { getArgoApps } = await import("@/lib/argocd")
const { evaluateAll } = await import("@/lib/scorecard")

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
