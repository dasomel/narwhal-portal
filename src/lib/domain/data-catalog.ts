/** Minimal, provider-neutral data catalog projection. */

export const DATA_CATALOG_KINDS = [
  "source", "dataset", "data_product", "pipeline", "query", "model", "embedding", "vector_index", "endpoint",
] as const

export type DataCatalogKind = (typeof DATA_CATALOG_KINDS)[number]
export type DataCatalogFreshnessState = "fresh" | "stale"

export interface DataCatalogIdentifier {
  provider: string
  nativeId: string
}

export interface DataCatalogScope {
  clusterId: string | null
  namespace: string | null
  teamId: string | null
  tenantId: string | null
}

export interface DataCatalogProvenance {
  source: string
  observedAt: string
  evidenceLink?: string
}

export interface DataCatalogClassification {
  value: "public" | "internal" | "confidential" | "restricted" | "unknown"
  source: string
  observedAt: string
  version: string | null
}

export interface DataCatalogEvidenceRef {
  id: string
  kind: "provider-record" | "event" | "report" | "artifact"
  provider: string
  locator: string
  digest: string | null
  observedAt: string
  scope: DataCatalogScope
}

export interface DataCatalogEntity {
  id: string
  kind: DataCatalogKind
  name: string
  identifier: DataCatalogIdentifier
  scope: DataCatalogScope
  provenance: DataCatalogProvenance
  classification: DataCatalogClassification
  evidenceRefs: DataCatalogEvidenceRef[]
  freshness: { state: "fresh" | "stale" | "unknown" | "unavailable"; observedAt: string; staleAfterSeconds: number }
}

export interface FreshnessPolicy {
  staleAfterSeconds: number
}

export interface CatalogEntityWithFreshness extends DataCatalogEntity {
  freshness: { state: DataCatalogFreshnessState; observedAt: string; staleAfterSeconds: number }
}

export type DataCatalogValidation =
  | { valid: true; entities: DataCatalogEntity[] }
  | { valid: false; reason: "invalid_entity" | "duplicate_id" }

const KINDS = new Set<string>(DATA_CATALOG_KINDS)
const SCOPE_KEYS = ["clusterId", "namespace", "teamId", "tenantId"] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidScope(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && SCOPE_KEYS.every((key) => value[key] === null || nonEmptyString(value[key]))
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

function validateEntity(value: unknown): value is DataCatalogEntity {
  if (!isPlainObject(value)) return false
  const identifier = value.identifier
  const scope = value.scope
  const provenance = value.provenance
  const classification = value.classification
  const freshness = value.freshness
  // Contract §2.1 maps provider/nativeId to identifier, observedAt to provenance.observedAt,
  // and requires classification, evidenceRefs, and freshness at the entity's top level.
  if (!isPlainObject(identifier) || !isPlainObject(scope) || !isPlainObject(provenance) ||
    !isPlainObject(classification) || !isPlainObject(freshness)) return false

  if (!nonEmptyString(value.id) || !KINDS.has(String(value.kind)) || !nonEmptyString(value.name) ||
    !nonEmptyString(identifier.provider) || !nonEmptyString(identifier.nativeId)) return false
  if (!SCOPE_KEYS.every((key) => scope[key] === null || nonEmptyString(scope[key]))) return false
  const classificationValues = new Set(["public", "internal", "confidential", "restricted", "unknown"])
  const freshnessStates = new Set(["fresh", "stale", "unknown", "unavailable"])
  if (!classificationValues.has(String(classification.value)) || !nonEmptyString(classification.source) ||
    !validTimestamp(classification.observedAt) || !(classification.version === null || nonEmptyString(classification.version))) return false
  if (!Array.isArray(value.evidenceRefs) || !freshnessStates.has(String(freshness.state)) ||
    !validTimestamp(freshness.observedAt) || typeof freshness.staleAfterSeconds !== "number" ||
    !Number.isFinite(freshness.staleAfterSeconds) || freshness.staleAfterSeconds < 0) return false
  if (!value.evidenceRefs.every((ref) => isPlainObject(ref) && nonEmptyString(ref.id) &&
    ["provider-record", "event", "report", "artifact"].includes(String(ref.kind)) &&
    nonEmptyString(ref.provider) && nonEmptyString(ref.locator) &&
    (ref.digest === null || nonEmptyString(ref.digest)) && validTimestamp(ref.observedAt) &&
    isValidScope(ref.scope))) return false
  return nonEmptyString(provenance.source) && validTimestamp(provenance.observedAt) &&
    (provenance.evidenceLink === undefined || nonEmptyString(provenance.evidenceLink))
}

/** Validates untrusted catalog records and rejects duplicate stable IDs. */
export function validateDataCatalogEntities(input: unknown): DataCatalogValidation {
  try {
    if (!Array.isArray(input)) return { valid: false, reason: "invalid_entity" }
    const ids = new Set<string>()
    const entities: DataCatalogEntity[] = []
    for (const item of input) {
      if (!validateEntity(item)) return { valid: false, reason: "invalid_entity" }
      if (ids.has(item.id)) return { valid: false, reason: "duplicate_id" }
      ids.add(item.id)
      entities.push(item)
    }
    return { valid: true, entities }
  } catch {
    return { valid: false, reason: "invalid_entity" }
  }
}

/** Adds freshness state without changing source timestamps; equality at the threshold is stale. */
export function markDataCatalogFreshness<T extends DataCatalogEntity>(
  entity: T,
  policy: FreshnessPolicy,
  now: Date,
): T & { freshness: CatalogEntityWithFreshness["freshness"] } {
  const observed = Date.parse(entity.provenance.observedAt)
  const staleAfterSeconds = policy.staleAfterSeconds
  const age = now.getTime() - observed
  const state = Number.isFinite(observed) && Number.isFinite(now.getTime()) && observed <= now.getTime() &&
    Number.isFinite(staleAfterSeconds) && staleAfterSeconds >= 0 && age < staleAfterSeconds * 1000 ? "fresh" : "stale"
  return {
    ...entity,
    freshness: { state, observedAt: entity.provenance.observedAt, staleAfterSeconds },
  }
}

/**
 * Exports only records whose complete four-part scope exactly matches an allowed scope.
 * Null dimensions match only null; visibility is filtered before output ordering/counting.
 */
export function exportDataCatalog(
  input: unknown,
  allowedScopes: readonly DataCatalogScope[],
): DataCatalogEntity[] {
  if (!Array.isArray(input) || !Array.isArray(allowedScopes)) return []
  const visibleScopes = new Set<string>()
  for (const scope of allowedScopes) {
    if (!isPlainObject(scope) || !SCOPE_KEYS.every((key) => scope[key] === null || nonEmptyString(scope[key]))) continue
    visibleScopes.add(JSON.stringify(SCOPE_KEYS.map((key) => scope[key])))
  }
  const visibleItems: Record<string, unknown>[] = []
  for (const item of input) {
    try {
      if (!isPlainObject(item)) continue
      const scope = item.scope
      if (!isValidScope(scope)) continue
      if (!visibleScopes.has(JSON.stringify(SCOPE_KEYS.map((key) => scope[key])))) continue
      visibleItems.push(item)
    } catch {
      // A malformed visible record is omitted without affecting other visible records.
    }
  }
  const idCounts = new Map<string, number>()
  for (const item of visibleItems) {
    if (nonEmptyString(item.id)) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1)
  }
  const visible: DataCatalogEntity[] = []
  for (const item of visibleItems) {
    if (!nonEmptyString(item.id) || idCounts.get(item.id) !== 1 || !validateEntity(item)) continue
    visible.push(item)
  }
  return visible.sort((a, b) => a.id.localeCompare(b.id))
}
