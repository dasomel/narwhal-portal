/** Pure storage quantity and PVC expansion domain rules. */

const MAX_STORAGE_BYTES = (BigInt("1") << BigInt("63")) - BigInt("1")
const STORAGE_MULTIPLIERS: Readonly<Record<string, bigint>> = {
  "": BigInt("1"),
  Ki: BigInt("1024"), Mi: BigInt("1024") ** BigInt("2"), Gi: BigInt("1024") ** BigInt("3"),
  Ti: BigInt("1024") ** BigInt("4"), Pi: BigInt("1024") ** BigInt("5"), Ei: BigInt("1024") ** BigInt("6"),
  k: BigInt("1000"), M: BigInt("1000") ** BigInt("2"), G: BigInt("1000") ** BigInt("3"),
  T: BigInt("1000") ** BigInt("4"), P: BigInt("1000") ** BigInt("5"), E: BigInt("1000") ** BigInt("6"),
}

export function parseStorageQuantity(input: unknown): bigint | null {
  if (typeof input !== "string" || input.length > 64) return null
  const match = /^(0|[1-9]\d*)(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.exec(input)
  if (!match || match[0] !== input) return null
  try {
    const fraction = match[2]?.slice(1) ?? ""
    const scale = BigInt("10") ** BigInt(fraction.length)
    // D1: Exact rational arithmetic rejects partial bytes; costs BigInt work. Relax only with a rounding contract.
    const numerator = BigInt(match[1] + fraction) * STORAGE_MULTIPLIERS[match[3] ?? ""]
    if (numerator % scale !== BigInt("0")) return null
    const bytes = numerator / scale
    return bytes <= MAX_STORAGE_BYTES ? bytes : null
  } catch {
    return null
  }
}

export interface StorageClassFacts {
  name: string
  allowVolumeExpansion: boolean | null
  provisioner: string | null
}

export interface PvcExpansionRequest {
  currentBytes: string | null
  requestedBytes: string
  storageClass: StorageClassFacts | null
  quotaHeadroomBytes: string | null
  boundPhase: "Bound" | string | null
  resizeInProgress: boolean | null
}

export const PVC_EXPANSION_REASONS = [
  "requested-unparseable",
  "requested-not-larger",
  "class-expansion-unsupported",
  "exceeds-quota-headroom",
  "resize-in-progress",
  "not-bound",
  "current-unknown",
  "class-unknown",
  "quota-evidence-missing",
  "phase-unknown",
  "resize-state-unknown",
] as const

export type PvcExpansionReason = (typeof PVC_EXPANSION_REASONS)[number]

export function evaluatePvcExpansion(input: unknown): {
  verdict: "allowed" | "blocked" | "needs-evidence"
  reasons: PvcExpansionReason[]
} {
  // D3: Snapshot untrusted facts; failed access costs evidence. Accept richer inputs only with a validation contract.
  let req: Record<string, unknown> = {}
  try {
    if (input !== null && typeof input === "object") {
      const source = input as Record<string, unknown>
      const storageClass = source.storageClass
      req = {
        requestedBytes: source.requestedBytes,
        currentBytes: source.currentBytes,
        quotaHeadroomBytes: source.quotaHeadroomBytes,
        boundPhase: source.boundPhase,
        resizeInProgress: source.resizeInProgress,
        expansion: storageClass !== null && typeof storageClass === "object"
          ? (storageClass as Record<string, unknown>).allowVolumeExpansion : undefined,
      }
    }
  } catch {
    req = {}
  }
  const requested = parseStorageQuantity(req.requestedBytes)
  const current = parseStorageQuantity(req.currentBytes)
  const headroom = parseStorageQuantity(req.quotaHeadroomBytes)
  const reasons: PvcExpansionReason[] = []
  if (requested === null) reasons.push("requested-unparseable")
  if (requested !== null && current !== null && requested <= current) reasons.push("requested-not-larger")
  if (req.expansion === false) reasons.push("class-expansion-unsupported")
  if (requested !== null && current !== null && headroom !== null && requested - current > headroom) {
    reasons.push("exceeds-quota-headroom")
  }
  if (req.resizeInProgress === true) reasons.push("resize-in-progress")
  if (typeof req.boundPhase === "string" && req.boundPhase !== "Bound") reasons.push("not-bound")
  const blocked = reasons.length > 0
  if (current === null) reasons.push("current-unknown")
  if (req.expansion !== true && req.expansion !== false) reasons.push("class-unknown")
  if (headroom === null) reasons.push("quota-evidence-missing")
  if (typeof req.boundPhase !== "string") reasons.push("phase-unknown")
  if (req.resizeInProgress !== true && req.resizeInProgress !== false) reasons.push("resize-state-unknown")
  // D2: Collect all reasons before applying precedence; incomplete evidence costs availability. Relax only with an evidence contract.
  return { verdict: blocked ? "blocked" : reasons.length > 0 ? "needs-evidence" : "allowed", reasons }
}
