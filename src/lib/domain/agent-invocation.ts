/** Pure resolved invocation binding, authorization and execution evidence rules. */
import { createHash } from "node:crypto"
import { types } from "node:util"

export const CANONICALIZATION_VERSIONS = ["v1"] as const
export const TOOL_RISKS = ["read-only", "mutating", "destructive"] as const
export type ToolRisk = (typeof TOOL_RISKS)[number]

export interface ResolutionArtifact {
  tool: string
  toolContractVersion: string
  target: { cluster: string; namespace: string | null }
  normalizedArgs: unknown
  canonicalizationVersion: string
}
export interface ToolRegistryEntry {
  risk: ToolRisk
  allowedArgKeys: readonly string[]
  requiredArgKeys: readonly string[]
  requiresApproval: boolean
}
export interface InvocationAuthzInput {
  resolution: unknown
  registry: ReadonlyMap<string, ToolRegistryEntry>
  sessionScope: { clusters: ReadonlySet<string>; namespaces: ReadonlySet<string>; allowedTools: ReadonlySet<string> }
  approval?: unknown
  now: Date
}

function own(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}
function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function matches(value: unknown, pattern: RegExp): value is string {
  if (typeof value !== "string") return false
  const match = pattern.exec(value)
  return match !== null && match[0] === value
}
function riskValue(value: unknown): value is ToolRisk {
  return value === "read-only" || value === "mutating" || value === "destructive"
}
const DIGEST = /^sha256:[0-9a-f]{64}$/
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** Accept local plain objects (including null prototypes) and local ordinary arrays only; reject foreign-realm prototypes. */
export function canonicalizeJson(value: unknown): string | null {
  try {
    let nodes = 0
    let length = 0
    const active = new Set<object>()
    const emit = (text: string): string => {
      length += text.length
      if (!Number.isSafeInteger(length) || length > 1_000_000) throw new Error("length")
      return text
    }
    const visit = (input: unknown, depth: number): string => {
      nodes++
      if (!Number.isSafeInteger(nodes) || nodes > 10_000 || depth > 16) throw new Error("budget")
      if (input === null) return emit("null")
      if (typeof input === "string") return emit(JSON.stringify(input))
      if (typeof input === "boolean") return emit(input ? "true" : "false")
      // D1: Normalize -0 to 0 for JSON equivalence; costs sign identity. Pin a new version to preserve it.
      if (typeof input === "number" && Number.isFinite(input)) return emit(JSON.stringify(input))
      if (typeof input !== "object" || types.isProxy(input) || active.has(input)) throw new Error("value")
      const array = Array.isArray(input)
      if (array ? Object.getPrototypeOf(input) !== Array.prototype : !plain(input)) throw new Error("prototype")
      const keys = Reflect.ownKeys(input)
      // D4: Bound descriptor allocation before copying; costs large inputs. Version the budget to expand it.
      if (keys.length > 10_000) throw new Error("budget")
      if (keys.some((key) => typeof key !== "string" || key === "__proto__")) throw new Error("key")
      const descriptors = Object.getOwnPropertyDescriptors(input)
      if (Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))) throw new Error("accessor")
      active.add(input)
      let result: string
      if (array) {
        const size = own(input, "length")
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size > 10_000 || keys.length !== size + 1) throw new Error("array")
        const parts: string[] = []
        emit("[")
        for (let i = 0; i < size; i++) {
          if (!Object.hasOwn(descriptors, String(i))) throw new Error("sparse")
          if (i > 0) emit(",")
          parts.push(visit(descriptors[String(i)].value, depth + 1))
        }
        emit("]")
        result = `[${parts.join(",")}]`
      } else {
        emit("{")
        const parts = (keys as string[]).sort().map((key, i) => {
          if (i > 0) emit(",")
          return emit(JSON.stringify(key)) + emit(":") + visit(descriptors[key].value, depth + 1)
        })
        emit("}")
        result = `{${parts.join(",")}}`
      }
      active.delete(input)
      return result
    }
    return visit(value, 0)
  } catch { return null }
}

function resolution(value: unknown): ResolutionArtifact | null {
  const tool = own(value, "tool")
  const toolContractVersion = own(value, "toolContractVersion")
  const target = own(value, "target")
  const cluster = own(target, "cluster")
  const namespace = own(target, "namespace")
  const normalizedArgs = own(value, "normalizedArgs")
  const canonicalizationVersion = own(value, "canonicalizationVersion")
  if (!matches(tool, /^[a-z][a-z0-9_.-]{0,63}$/) || !matches(toolContractVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/) ||
    !matches(cluster, LABEL) || !(namespace === null || matches(namespace, LABEL)) ||
    canonicalizationVersion !== CANONICALIZATION_VERSIONS[0] || canonicalizeJson(normalizedArgs) === null) return null
  return { tool, toolContractVersion, target: { cluster, namespace }, normalizedArgs, canonicalizationVersion }
}
export function computeInvocationDigest(r: unknown): string | null {
  try {
    const resolved = resolution(r)
    if (resolved === null) return null
    const json = canonicalizeJson(resolved)
    return json === null ? null : `sha256:${createHash("sha256").update(json).digest("hex")}`
  } catch { return null }
}

type ApprovalReason = "ok" | "missing" | "digest-mismatch" | "expired" | "invalid-expiry" | "no-approver" | "agent-approver" | "invalid-digest" | "invalid-clock" | "invalid-approval-id"
function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || match[0] !== value) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  const zone = match[8]
  const offset = zone === "Z" ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === "+" ? 1 : -1)
  return date.getTime() + Number(`0.${match[7] ?? "0"}`) * 1000 - offset * 60000
}
/** Date subclasses use intrinsic time, ignoring overrides. Single-use consumption is enforced by the executor's durable ledger keyed by approvalId; this pure module cannot enforce it. */
export function verifyApprovalBinding(approval: unknown, digest: string | null, now: Date): { valid: boolean; reason: ApprovalReason; approvalId: string | null } {
  const fail = (reason: ApprovalReason) => ({ valid: false, reason, approvalId: null })
  try {
    if (!matches(digest, DIGEST)) return fail("invalid-digest")
    const clock = types.isProxy(now) ? NaN : Date.prototype.getTime.call(now)
    if (!Number.isSafeInteger(clock)) return fail("invalid-clock")
    if (approval === null || approval === undefined) return fail("missing")
    if (own(approval, "invocationDigest") !== digest) return fail("digest-mismatch")
    const approvalId = own(approval, "approvalId")
    if (!matches(approvalId, /^[A-Za-z0-9-]{8,128}$/)) return fail("invalid-approval-id")
    if (own(approval, "approverKind") !== "human") return fail("agent-approver")
    const by = own(approval, "approvedBy")
    if (typeof by !== "string" || by.trim().length === 0) return fail("no-approver")
    const expiry = timestamp(own(approval, "expiresAt"))
    // D2: Cap approval lifetime at one hour; costs renewal. Change only with an approval lifetime contract.
    if (expiry === null || !Number.isFinite(expiry) || expiry - clock > 3600000) return fail("invalid-expiry")
    if (!(expiry > clock)) return fail("expired")
    return { valid: true, reason: "ok", approvalId }
  } catch { return fail("invalid-clock") }
}

export function authorizeInvocation(input: InvocationAuthzInput): { decision: "allow" | "deny" | "needs-approval"; reasons: string[]; digest: string | null; risk: ToolRisk | null; approvalId: string | null } {
  let digest: string | null = null
  let risk: ToolRisk | null = null
  let approvalId: string | null = null
  const deny = (reason: string) => ({ decision: "deny" as const, reasons: [reason], digest, risk, approvalId })
  try {
    const resolved = resolution(own(input, "resolution"))
    digest = computeInvocationDigest(resolved)
    if (resolved === null || digest === null) return deny("digest-invalid")
    const now = own(input, "now")
    if (typeof now !== "object" || now === null || types.isProxy(now) || !Number.isSafeInteger(Date.prototype.getTime.call(now))) return deny("digest-invalid")
    const registry = own(input, "registry")
    if (typeof registry !== "object" || registry === null || types.isProxy(registry)) return deny("tool-unregistered")
    let entry: unknown
    try { entry = Map.prototype.get.call(registry, resolved.tool) } catch { return deny("tool-unregistered") }
    const entryRisk = own(entry, "risk")
    const rawAllowed = own(entry, "allowedArgKeys")
    const rawRequired = own(entry, "requiredArgKeys")
    const approvalRequired = own(entry, "requiresApproval")
    const strings = (value: unknown): string[] | null => {
      if (!Array.isArray(value) || types.isProxy(value) || canonicalizeJson(value) === null) return null
      const result: string[] = []
      const size = own(value, "length")
      if (typeof size !== "number" || !Number.isSafeInteger(size)) return null
      for (let i = 0; i < size; i++) {
        const key = own(value, String(i))
        if (typeof key !== "string") return null
        result.push(key)
      }
      return result
    }
    const allowed = strings(rawAllowed)
    const required = strings(rawRequired)
    if (!riskValue(entryRisk) || allowed === null || required === null ||
      required.some((key) => !allowed.includes(key)) || typeof approvalRequired !== "boolean") return deny("tool-unregistered")
    risk = entryRisk
    const scope = own(input, "sessionScope")
    const has = (field: string, value: string): boolean => {
      const set = own(scope, field)
      try { return value !== "*" && typeof set === "object" && set !== null && !types.isProxy(set) && Set.prototype.has.call(set, value) === true } catch { return false }
    }
    if (!has("allowedTools", resolved.tool)) return deny("tool-not-granted")
    if (!has("clusters", resolved.target.cluster)) return deny("cluster-out-of-scope")
    const namespace = resolved.target.namespace
    if ((namespace === null && risk !== "read-only") || (namespace !== null && !has("namespaces", namespace))) return deny("namespace-out-of-scope")
    const args = resolved.normalizedArgs
    if (!plain(args) || Object.getOwnPropertyNames(args).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(args, key))) return deny("args-schema")
    // D3: Only server registry risk grants authority; costs registry maintenance. Revise the trust boundary to relax.
    if (risk === "destructive" || approvalRequired === true) {
      const binding = verifyApprovalBinding(own(input, "approval"), digest, own(input, "now") as Date)
      if (!binding.valid) return { decision: "needs-approval", reasons: [binding.reason], digest, risk, approvalId }
      approvalId = binding.approvalId
    }
    return { decision: "allow", reasons: [], digest, risk, approvalId }
  } catch { return deny("digest-invalid") }
}

/** risk MUST be the value returned by authorizeInvocation, never caller/model supplied. */
export function evaluateMutationOutcome(input: unknown): { status: "verified-success" | "unverified" | "failed" | "invalid"; reasons: string[] } {
  const result = (status: "verified-success" | "unverified" | "failed" | "invalid", reason?: string) => ({ status, reasons: reason ? [reason] : [] })
  try {
    const risk = own(input, "risk")
    const success = own(input, "executorReportedSuccess")
    const expected = own(input, "expectedInvocationDigest")
    const post = own(input, "postState")
    if (!riskValue(risk) || typeof success !== "boolean" || !matches(expected, DIGEST)) return result("invalid", "malformed")
    if (post !== null && (typeof own(post, "verified") !== "boolean" || !(own(post, "observedDigest") === null || matches(own(post, "observedDigest"), DIGEST)))) return result("invalid", "malformed")
    if (success === false) return result("failed", "executor-failed")
    if (risk === "read-only") return result("verified-success")
    if (matches(expected, DIGEST) && own(post, "verified") === true && own(post, "observedDigest") === expected) return result("verified-success")
    return result("unverified", "post-state-unverified")
  } catch { return result("invalid", "malformed") }
}
