/** Pure Hubble flow visibility and normalization rules. */

export const FLOW_VERDICTS = ["forwarded", "dropped", "audit", "unknown"] as const
export type FlowVerdict = (typeof FLOW_VERDICTS)[number]

export interface FlowScope {
  all: boolean
  namespaces: ReadonlySet<string>
}

export interface FlowEndpointSummary {
  redacted: boolean
  namespace: string | null
  workload: string | null
  pod: string | null
}

export interface FlowSummary {
  uuid: string
  verdict: FlowVerdict
  time: string | null
  source: FlowEndpointSummary
  destination: FlowEndpointSummary
  dropReason: string | null
  policies: {
    direction: "egress" | "ingress"
    effect: "allowed" | "denied"
    name: string | null
    namespace: string | null
    redacted: boolean
  }[]
  traceId: string | null
}

function own(input: unknown, key: string): unknown {
  // D1: Failed or inherited reads are absent; costs evidence. Relax only with a trusted-input contract.
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
    return Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined
  } catch {
    return undefined
  }
}

function nonempty(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null
}

function matching(input: unknown, pattern: RegExp): string | null {
  if (typeof input !== "string") return null
  const match = pattern.exec(input)
  return match && match[0] === input ? input : null
}

export function normalizeFlowVerdict(input: unknown): FlowVerdict {
  if (input === "FORWARDED") return "forwarded"
  if (input === "DROPPED") return "dropped"
  if (input === "AUDIT") return "audit"
  return "unknown"
}

function strictTime(input: unknown): string | null {
  const value = matching(input, /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/)
  if (value === null) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  // D2: Mirror policy calendar validation; costs a month-length check. Relax only with a timestamp contract.
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return day <= days ? value : null
}

export function normalizeFlow(raw: unknown, scope: FlowScope): FlowSummary | null {
  try {
    const uuid = matching(own(raw, "uuid"), /^[A-Za-z0-9-]{1,128}$/)
    if (uuid === null) return null
    // D4: Scope must be a plain object; accessor/prototype fields fail closed.
    // Costs custom scope objects; relax only with a trusted scope contract.
    if (scope === null || typeof scope !== "object" || Object.getPrototypeOf(scope) !== Object.prototype) return null
    const allField = Object.getOwnPropertyDescriptor(scope, "all")
    const namespacesField = Object.getOwnPropertyDescriptor(scope, "namespaces")
    if ((allField && !("value" in allField)) || (namespacesField && !("value" in namespacesField))) return null
    const all = allField?.value === true
    const namespaces = namespacesField?.value
    const visible = (namespace: string | null): boolean => {
      if (all) return true
      try {
        return namespace !== null && namespaces instanceof Set && Set.prototype.has.call(namespaces, namespace) === true
      } catch {
        return false
      }
    }
    const source = own(raw, "source")
    const destination = own(raw, "destination")
    const sourceNamespace = nonempty(own(source, "namespace"))
    const destinationNamespace = nonempty(own(destination, "namespace"))
    // D3: Require positive visibility before emitting any flow; costs unavailable flows. Relax only with a revised scope contract.
    if (!visible(sourceNamespace) && !visible(destinationNamespace)) return null
    const endpoint = (input: unknown, namespace: string | null): FlowEndpointSummary => {
      if (!visible(namespace)) return { redacted: true, namespace: null, workload: null, pod: null }
      const workloads = own(input, "workloads")
      let workload: string | null = null
      if (Array.isArray(workloads)) {
        for (let index = 0; index < workloads.length; index++) {
          if (!Object.hasOwn(workloads, index)) continue
          workload = nonempty(own(workloads[index], "name"))
          if (workload !== null) break
        }
      }
      return { redacted: false, namespace, workload, pod: nonempty(own(input, "pod_name")) }
    }
    const policies: FlowSummary["policies"] = []
    for (const direction of ["egress", "ingress"] as const) {
      for (const effect of ["allowed", "denied"] as const) {
        const refs = own(raw, `${direction}_${effect}_by`)
        if (!Array.isArray(refs)) continue
        for (let index = 0; index < refs.length; index++) {
          const ref = Object.hasOwn(refs, index) ? refs[index] : undefined
          const namespace = nonempty(own(ref, "namespace"))
          const redacted = !visible(namespace)
          policies.push({ direction, effect, name: redacted ? null : nonempty(own(ref, "name")), namespace: redacted ? null : namespace, redacted })
        }
      }
    }
    const verdict = normalizeFlowVerdict(own(raw, "verdict"))
    return {
      uuid, verdict, time: strictTime(own(raw, "time")),
      source: endpoint(source, sourceNamespace), destination: endpoint(destination, destinationNamespace),
      dropReason: verdict === "dropped" ? matching(own(raw, "drop_reason_desc"), /^[A-Z][A-Z0-9_]{0,63}$/) : null,
      policies,
      traceId: matching(own(own(own(raw, "trace_context"), "parent"), "trace_id"), /^[0-9a-f]{32}$/),
    }
  } catch {
    return null
  }
}

function positiveInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input) && Number.isInteger(input) && input >= 1
}

export function clampFlowLimit(n: unknown, opts?: { default?: number; max?: number }): number {
  const requestedMax = own(opts, "max")
  const requestedDefault = own(opts, "default")
  const max = positiveInteger(requestedMax) ? Math.min(requestedMax, 1000) : 1000
  const fallback = Math.min(positiveInteger(requestedDefault) ? requestedDefault : 100, max)
  return positiveInteger(n) ? Math.min(n, max) : fallback
}
