import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { evaluatePvcExpansion, parseStorageQuantity, type StorageClassFacts } from "@/lib/domain/storage"
import { getPersistentVolumeClaim, getResourceQuotas, getStorageClass, K8sHttpError } from "@/lib/k8s-client"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

const NAMESPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const PVC_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined
}

function stringMap(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((entry) => typeof entry === "string")
}

function quotaHeadroom(raw: unknown, className: string | null): string | null {
  // D7: only an identified, complete list proves quota evidence; malformed or
  // truncated reads cost availability. Revisit with a pagination contract.
  try {
    const list = record(raw)
    const items = own(list, "items")
    if (own(list, "kind") !== "ResourceQuotaList" || !Array.isArray(items) ||
      Object.hasOwn(record(own(list, "metadata")), "continue")) return null
    const keys = ["requests.storage", ...(className === null ? [] :
      [`${className}.storageclass.storage.k8s.io/requests.storage`])]
    let minimum: bigint | null = null
    for (const item of items) {
      const entry = record(item)
      const status = record(entry.status)
      const hard = status.hard
      const used = status.used
      // Check mentions before shape validation so a malformed covering quota
      // cannot be skipped in favor of another quota with ample headroom.
      const mentions = (value: unknown, key: string) => value !== null &&
        typeof value === "object" && key in value
      const covering = keys.some((key) => mentions(hard, key) || mentions(used, key))
      if (!covering) continue
      if (!Object.hasOwn(entry, "status") || !Object.hasOwn(status, "hard") ||
        !Object.hasOwn(status, "used") || !stringMap(hard) || !stringMap(used)) return null
      for (const key of keys) {
        if (!Object.hasOwn(hard, key)) {
          if (key in hard || key in used) return null
          continue
        }
        const limit = parseStorageQuantity(hard[key])
        const consumed = parseStorageQuantity(own(used, key))
        if (limit === null || consumed === null) return null
        const remaining = limit > consumed ? limit - consumed : BigInt("0")
        if (minimum === null || remaining < minimum) minimum = remaining
      }
    }
    // D8: no covering key is unknown: the domain cannot express unlimited,
    // and other admission constraints exist. Extend the domain to change this.
    const text = minimum === null ? null : minimum.toString()
    return parseStorageQuantity(text) === null ? null : text
  } catch {
    return null
  }
}

export async function POST(req: Request) {
  const gate = await requireRole("cluster-admin", "developer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  let body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    typeof body.cluster_id !== "string" || body.cluster_id.length > 253 || !/^\S+$/.test(body.cluster_id) ||
    typeof body.namespace !== "string" || !NAMESPACE_NAME.test(body.namespace) || body.namespace.includes("\n") ||
    typeof body.pvc_name !== "string" || body.pvc_name.length > 253 || !PVC_NAME.test(body.pvc_name) || body.pvc_name.includes("\n") ||
    typeof body.requested_size !== "string" || body.requested_size.length > 64
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // D1: scope only supports the default cluster; other ids cost availability
  // until cluster-aware adapters exist, rather than reading the wrong tenant.
  if (body.cluster_id !== DEFAULT_CLUSTER_ID) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let pvc: unknown
  try {
    const scope = await getEffectiveScope(gate.session, DEFAULT_CLUSTER_ID)
    if (!namespaceVisible(body.namespace, scope)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    try {
      pvc = await getPersistentVolumeClaim(body.namespace, body.pvc_name)
    } catch (error) {
      if (error instanceof K8sHttpError && error.status === 404) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }
      throw error
    }
  } catch (error) {
    console.error("PVC expansion preflight cluster lookup failed", error)
    return NextResponse.json({ error: "Cluster unavailable" }, { status: 503 })
  }

  const status = record(record(pvc).status)
  const current = record(status.capacity).storage
  const phase = status.phase
  const storageClassName = record(record(pvc).spec).storageClassName
  const conditions = status.conditions
  // D2: malformed conditions cost evidence instead of implying no resize.
  // Accept additional shapes only after a Kubernetes condition contract exists.
  const resizing = Array.isArray(conditions) && conditions.some((condition) => {
    const entry = record(condition)
    return (entry.type === "Resizing" || entry.type === "FileSystemResizePending") && entry.status === "True"
  })
  const validConditions = Array.isArray(conditions) && conditions.every((condition) => {
    const entry = record(condition)
    return typeof entry.type === "string" && ["True", "False", "Unknown"].includes(entry.status as string)
  })
  // D4: echo only bounded domain values, losing malformed cluster evidence;
  // extend these validators only when the supported storage contract changes.
  const facts = {
    current_bytes_text: typeof current === "string" && parseStorageQuantity(current) !== null ? current : null,
    storage_class_name: typeof storageClassName === "string" && /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(storageClassName) && !storageClassName.includes("\n") ? storageClassName : null,
    phase: typeof phase === "string" && ["Pending", "Bound", "Lost"].includes(phase) ? phase : null,
    resize_in_progress: resizing ? true : validConditions ? false : null,
  }
  let storageClass: StorageClassFacts | null = null
  if (facts.storage_class_name !== null) {
    try {
      const raw: unknown = await getStorageClass(facts.storage_class_name)
      const entry = record(raw)
      const metadata = record(own(entry, "metadata"))
      // D5: only a positively identified class supplies facts; other shapes cost
      // evidence. Relax this guard only if the upstream resource contract changes.
      if (own(entry, "kind") === "StorageClass" && own(metadata, "name") === facts.storage_class_name) {
        // Kubernetes defaults an absent expansion field to false on this class.
        const expansion = own(entry, "allowVolumeExpansion")
        storageClass = {
          name: facts.storage_class_name,
          allowVolumeExpansion: expansion === true ? true : expansion === false ? false
            : Object.hasOwn(entry, "allowVolumeExpansion") ? null : false,
          provisioner: null,
        }
      }
    } catch (error) {
      // D6: unavailable class reads cost evidence, never the whole preflight.
      // narwhal#315 owns RBAC synchronization; retry via a later request.
      console.error("PVC expansion preflight StorageClass lookup failed", error)
    }
  }
  let quotaHeadroomBytes: string | null = null
  try {
    quotaHeadroomBytes = quotaHeadroom(await getResourceQuotas(body.namespace), facts.storage_class_name)
  } catch {
    // Failed quota reads provide no evidence; do not expose upstream details.
  }
  // D9: LimitRange max.storage and PV backend limits remain unread. This
  // costs an allowed verdict until those constraints have verified readers.
  const evidenceGaps = [
    ...(storageClass?.allowVolumeExpansion === true || storageClass?.allowVolumeExpansion === false
      ? [] : ["storage-class"]),
    ...(quotaHeadroomBytes === null ? ["quota"] : []),
    "limit-range",
  ]
  const result = evaluatePvcExpansion({
    currentBytes: facts.current_bytes_text,
    requestedBytes: body.requested_size,
    boundPhase: facts.phase,
    resizeInProgress: facts.resize_in_progress,
    storageClass,
    quotaHeadroomBytes,
  })
  return NextResponse.json({
    ...result,
    verdict: result.verdict === "allowed" && evidenceGaps.length > 0 ? "needs-evidence" : result.verdict,
    reasons: result.verdict === "allowed" && evidenceGaps.length > 0
      ? [...result.reasons, "unread-constraints"] : result.reasons,
    namespace: body.namespace, pvc_name: body.pvc_name,
    facts: { ...facts, quota_headroom_bytes_text: quotaHeadroomBytes, expansion_supported: storageClass?.allowVolumeExpansion ?? null },
    evidence_gaps: evidenceGaps,
  })
}
