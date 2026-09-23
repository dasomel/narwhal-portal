/**
 * Kubernetes informer for the live event stream (`/live`).
 *
 * Watches core/v1 Events cluster-wide and forwards them to the live stream via
 * pushEvent(). Started once from instrumentation.ts on the Node.js runtime.
 * Previously this was a TODO stub that was never invoked, so `/live` had no event
 * source at all — the page could only ever show what the /api/events/ingest webhook
 * received (nothing was posting to it).
 */
import { getK8sApiServer } from "./config"
import { getK8sBearerToken, invalidateK8sBearerToken } from "./k8s-token"
import { pushEvent } from "./live-stream"
import type { LiveEventIngest, LiveEventType, LiveSeverity } from "@/types/live"
import type { EventResource } from "@/types/event-envelope"

function useBearer(apiServer: string): boolean {
  return apiServer.startsWith("https://")
}

/** True if the informer has a usable bearer token for `apiServer` right now — used both to decide whether to start and to log a clear disable reason instead of crashing on a production misconfiguration. */
function hasBearerToken(apiServer: string): boolean {
  if (!useBearer(apiServer)) return false
  try {
    return getK8sBearerToken().length > 0
  } catch {
    return false
  }
}

let started = false

// Warning events are always surfaced. Normal events are mostly noise (probes,
// image pulls, sandbox churn) — only forward a curated set of meaningful reasons.
const NORMAL_REASON_ALLOW = new Set<string>([
  "Scheduled", "Started", "Created", "Killing", "Pulled", "BackOff",
  "SuccessfulCreate", "SuccessfulDelete", "ScalingReplicaSet",
  "NodeReady", "NodeNotReady", "Rebooted", "LeaderElection", "Completed",
])

interface K8sEvent {
  metadata?: { uid?: string; resourceVersion?: string }
  reason?: string
  message?: string
  type?: string // "Normal" | "Warning"
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

function headers(apiServer: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (useBearer(apiServer)) {
    const token = getK8sBearerToken()
    if (token.length > 0) h.Authorization = `Bearer ${token}`
  }
  return h
}

function toIngest(ev: K8sEvent): LiveEventIngest | null {
  const reason = ev.reason ?? ""
  const isWarning = ev.type === "Warning"
  if (!isWarning && !NORMAL_REASON_ALLOW.has(reason)) return null

  const io = ev.involvedObject ?? {}
  const severity: LiveSeverity = isWarning ? "warning" : "info"

  let type: LiveEventType = "custom"
  if (isWarning) {
    type = "alert"
  } else if (
    io.kind === "Pod" ||
    io.kind === "Deployment" ||
    io.kind === "ReplicaSet" ||
    io.kind === "StatefulSet" ||
    io.kind === "DaemonSet" ||
    io.kind === "Job" ||
    io.kind === "CronJob"
  ) {
    type = "deploy"
  } else if (io.kind === "Application" || reason === "LeaderElection") {
    type = "sync"
  } else if (io.kind === "Node") {
    type = "node"
  }

  const objRef = `${io.kind ?? "Object"} ${io.name ?? ""}`.trim()

  // portal#12: structured resource + explicit visibility, not a `namespace=<ns>`
  // description tag for the SSE route to regex back out. A namespaced involvedObject
  // (Pod, Deployment, ...) is scoped via resource.namespace like everything else; a
  // cluster-scoped one (Node, LeaderElection) has no namespace and must declare
  // visibility explicitly — "cluster" here, not left absent (which now default-denies).
  const resource: EventResource = { kind: io.kind, name: io.name, namespace: io.namespace }
  return {
    type,
    severity,
    source: "kubernetes",
    title: `${objRef} — ${reason || "Event"}`.slice(0, 200),
    description: (ev.message ?? "").slice(0, 500),
    resource,
    visibility: io.namespace ? "namespace" : "cluster",
  }
}

async function getLatestResourceVersion(apiServer: string): Promise<string> {
  const res = await fetch(`${apiServer}/api/v1/events?limit=1`, { headers: headers(apiServer) })
  if (!res.ok) {
    // Rotated/expired token — drop the cache so the next retry (outer loop's
    // backoff in startLiveK8sInformer) re-reads the projected token file.
    if (res.status === 401) invalidateK8sBearerToken()
    throw new Error(`list events ${res.status}`)
  }
  const body = (await res.json()) as { metadata?: { resourceVersion?: string } }
  return body.metadata?.resourceVersion ?? "0"
}

/** Runs one watch connection; returns the last-seen resourceVersion when it ends. */
async function watchOnce(apiServer: string, resourceVersion: string): Promise<string> {
  const url =
    `${apiServer}/api/v1/events` +
    `?watch=1&resourceVersion=${encodeURIComponent(resourceVersion)}&timeoutSeconds=300`
  const res = await fetch(url, { headers: headers(apiServer) })
  if (!res.ok || !res.body) {
    if (res.status === 401) invalidateK8sBearerToken()
    throw new Error(`watch events ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let rv = resourceVersion
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const evt = JSON.parse(line) as { type: string; object: K8sEvent }
        const obj = evt.object
        if (obj?.metadata?.resourceVersion) rv = obj.metadata.resourceVersion
        // Only surface newly-created events (skip MODIFIED/DELETED/BOOKMARK/ERROR).
        if (evt.type === "ADDED") {
          const ingest = toIngest(obj)
          if (ingest) void pushEvent(ingest).catch(() => {})
        }
      } catch {
        // malformed line — skip
      }
    }
  }
  return rv
}

export function startLiveK8sInformer(): void {
  if (started) return
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return
  const apiServer = getK8sApiServer()
  if (!hasBearerToken(apiServer)) {
    console.warn("[live-k8s-informer] no K8s bearer token available — live event informer disabled")
    return
  }
  started = true
  console.log("[live-k8s-informer] starting core/v1 Events watch")

  void (async () => {
    let rv = "0"
    let backoff = 1000
    for (;;) {
      try {
        if (rv === "0") rv = await getLatestResourceVersion(apiServer)
        rv = await watchOnce(apiServer, rv)
        backoff = 1000 // clean cycle — reset backoff
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 410 Gone: resourceVersion too old — resync from the latest.
        if (msg.includes("410")) {
          rv = "0"
          continue
        }
        console.warn("[live-k8s-informer] watch error, retrying:", msg)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  })()
}
