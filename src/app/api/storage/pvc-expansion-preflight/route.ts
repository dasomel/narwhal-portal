import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { evaluatePvcExpansion, parseStorageQuantity, type StorageClassFacts } from "@/lib/domain/storage"
import { getPersistentVolumeClaim, getStorageClass, K8sHttpError } from "@/lib/k8s-client"
import { getEffectiveScope, namespaceVisible } from "@/lib/scope"
import { DEFAULT_CLUSTER_ID } from "@/types/cluster"

const NAMESPACE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const PVC_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
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
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const entry = record(raw)
        // D5: Kubernetes treats an absent expansion field as false; malformed
        // values cost evidence. Relax only when the upstream contract changes.
        const expansion = entry.allowVolumeExpansion
        storageClass = {
          name: facts.storage_class_name,
          allowVolumeExpansion: expansion === true ? true : expansion === false ? false
            : Object.hasOwn(entry, "allowVolumeExpansion") ? null : false,
          provisioner: typeof entry.provisioner === "string" ? entry.provisioner : null,
        }
      }
    } catch (error) {
      // D6: unavailable class reads cost evidence, never the whole preflight.
      // narwhal#315 owns RBAC synchronization; retry via a later request.
      console.error("PVC expansion preflight StorageClass lookup failed", error)
    }
  }
  // D3: quota remains unread: absence of a ResourceQuota cannot yet be
  // represented in the domain model. This costs availability until that model changes.
  const result = evaluatePvcExpansion({
    currentBytes: facts.current_bytes_text,
    requestedBytes: body.requested_size,
    boundPhase: facts.phase,
    resizeInProgress: facts.resize_in_progress,
    storageClass,
    quotaHeadroomBytes: null,
  })
  return NextResponse.json({
    ...result, namespace: body.namespace, pvc_name: body.pvc_name,
    facts: { ...facts, expansion_supported: storageClass?.allowVolumeExpansion ?? null },
    evidence_gaps: storageClass?.allowVolumeExpansion === true || storageClass?.allowVolumeExpansion === false
      ? ["quota"] : ["storage-class", "quota"],
  })
}
