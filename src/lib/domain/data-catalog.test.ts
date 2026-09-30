import { describe, expect, it } from "vitest"
import {
  exportDataCatalog,
  markDataCatalogFreshness,
  validateDataCatalogEntities,
  type DataCatalogEntity,
  type DataCatalogScope,
} from "./data-catalog"

const visibleScope: DataCatalogScope = { clusterId: "c1", namespace: "analytics", teamId: "data", tenantId: null }
const entity = (id: string, scope = visibleScope): DataCatalogEntity => ({
  id,
  kind: "dataset",
  name: "Orders",
  identifier: { provider: "iceberg", nativeId: "warehouse.orders" },
  scope,
  provenance: {
    source: "catalog-provider",
    observedAt: "2026-09-30T10:00:00Z",
    evidenceLink: "https://evidence.invalid/record/1",
  },
  classification: { value: "unknown", source: "catalog-provider", observedAt: "2026-09-30T10:00:00Z", version: null },
  evidenceRefs: [],
  freshness: { state: "fresh", observedAt: "2026-09-30T10:00:00Z", staleAfterSeconds: 3600 },
})

describe("data catalog domain", () => {
  it("accepts complete entities and rejects missing or malformed provenance", () => {
    expect(validateDataCatalogEntities([entity("dataset:iceberg:1")])).toMatchObject({ valid: true })
    const missing = { ...entity("missing"), provenance: undefined }
    const malformed = { ...entity("bad-date"), provenance: { ...entity("x").provenance, observedAt: "yesterday" } }
    expect(validateDataCatalogEntities([missing]).valid).toBe(false)
    expect(validateDataCatalogEntities([malformed])).toEqual({ valid: false, reason: "invalid_entity" })
    expect(validateDataCatalogEntities({})).toEqual({ valid: false, reason: "invalid_entity" })
  })

  it("requires every common entity field in the provenance contract", () => {
    const removals: Array<(copy: Record<string, any>) => void> = [
      (copy) => { delete copy.id },
      (copy) => { delete copy.kind },
      (copy) => { delete copy.name },
      (copy) => { delete copy.identifier.provider },
      (copy) => { delete copy.identifier.nativeId },
      (copy) => { delete copy.scope },
      (copy) => { delete copy.provenance.observedAt },
      (copy) => { delete copy.classification },
      (copy) => { delete copy.evidenceRefs },
      (copy) => { delete copy.freshness },
    ]
    for (const remove of removals) {
      const copy = structuredClone(entity("required-fields")) as Record<string, any>
      remove(copy)
      expect(validateDataCatalogEntities([copy]).valid).toBe(false)
    }
    const withoutEvidenceLink = entity("optional-evidence-link")
    delete (withoutEvidenceLink.provenance as Partial<typeof withoutEvidenceLink.provenance>).evidenceLink
    expect(validateDataCatalogEntities([withoutEvidenceLink]).valid).toBe(true)
  })

  it("rejects duplicate stable identifiers and hostile records", () => {
    expect(validateDataCatalogEntities([entity("same"), entity("same")])).toEqual({
      valid: false,
      reason: "duplicate_id",
    })
    const hostile = Object.create({ id: "inherited" })
    expect(validateDataCatalogEntities([hostile])).toEqual({ valid: false, reason: "invalid_entity" })
    const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("hostile") } })
    expect(validateDataCatalogEntities([throwingProxy])).toEqual({ valid: false, reason: "invalid_entity" })
  })

  it("marks the freshness threshold boundary stale using the injected clock", () => {
    const record = entity("freshness")
    expect(markDataCatalogFreshness(record, { staleAfterSeconds: 60 }, new Date("2026-09-30T10:00:59Z")).freshness.state)
      .toBe("fresh")
    expect(markDataCatalogFreshness(record, { staleAfterSeconds: 60 }, new Date("2026-09-30T10:01:00Z")).freshness.state)
      .toBe("stale")
    expect(markDataCatalogFreshness(record, { staleAfterSeconds: 60 }, new Date("2026-09-30T10:00:00Z")).freshness.state)
      .toBe("fresh")
    expect(markDataCatalogFreshness(record, { staleAfterSeconds: 60 }, new Date("2026-09-30T09:59:59Z")).freshness.state)
      .toBe("stale")
  })

  it("filters by exact scope before output, hides other-scope counts, and replays deterministically", () => {
    const hidden = entity("secret:existence", { ...visibleScope, tenantId: "other-tenant" })
    const input = [entity("dataset:z"), hidden, entity("dataset:a")]
    const first = exportDataCatalog(input, [visibleScope])
    const second = exportDataCatalog(input, [visibleScope])
    expect(first.map(({ id }) => id)).toEqual(["dataset:a", "dataset:z"])
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain("secret:existence")
    expect(first).toHaveLength(2)
    expect(exportDataCatalog([hidden], [visibleScope])).toEqual([])
  })

  it("ignores hidden malformed and duplicate IDs while excluding invalid visible records only", () => {
    const hiddenScope = { ...visibleScope, tenantId: "hidden" }
    const hiddenMalformed = { scope: hiddenScope, id: "hidden-bad" }
    const hiddenDuplicateA = entity("shared", hiddenScope)
    const hiddenDuplicateB = { ...entity("shared", hiddenScope), kind: "not-a-kind" }
    const invalidVisible = { ...entity("visible-bad"), provenance: undefined }
    const result = exportDataCatalog([
      hiddenMalformed, hiddenDuplicateA, hiddenDuplicateB, invalidVisible, entity("visible-good"),
    ], [visibleScope])
    expect(result.map(({ id }) => id)).toEqual(["visible-good"])
  })

  it("excludes every visible record with a duplicate ID regardless of input order", () => {
    const first = entity("duplicate-visible")
    const conflicting = { ...entity("duplicate-visible"), name: "Conflicting provider record" }
    const expected = [entity("unique-visible")]
    const forward = exportDataCatalog([first, conflicting, ...expected], [visibleScope])
    const reverse = exportDataCatalog([expected[0], conflicting, first], [visibleScope])
    expect(forward).toEqual(expected)
    expect(reverse).toEqual(forward)
  })
})

describe("data catalog export scope validation", () => {
  it("ignores malformed allowed scopes instead of letting missing keys widen visibility to null-scoped records", () => {
    const globalScope: DataCatalogScope = { clusterId: null, namespace: null, teamId: null, tenantId: null }
    const records = [entity("global:1", globalScope), entity("scoped:1")]
    const hostile = [{}, { clusterId: "", namespace: "", teamId: "", tenantId: "" }, { clusterId: undefined }] as unknown as DataCatalogScope[]
    expect(exportDataCatalog(records, hostile)).toEqual([])
    expect(exportDataCatalog(records, [...hostile, visibleScope]).map((item) => item.id)).toEqual(["scoped:1"])
  })
})
