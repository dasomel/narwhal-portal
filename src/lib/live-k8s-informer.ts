/**
 * Kubernetes informer for the live event stream (`/live`).
 *
 * Watches core/v1 Events cluster-wide and forwards them to the live stream via
 * pushEvent(). Started once from instrumentation.ts on the Node.js runtime.
 * Previously this was a TODO stub that was never invoked, so `/live` had no event
 * source at all — the page could only ever show what the /api/events/ingest webhook
 * received (nothing was posting to it).
 */
import { listEventsForResync } from "./k8s-event-resync"
import { getK8sApiServer } from "./config"
import { getK8sBearerToken, invalidateK8sBearerToken } from "./k8s-token"
import { pushEvent } from "./live-stream"
import { claimIdempotencyKey, getIdempotencyStore } from "./idempotency"
import { getValkey } from "./valkey"
import { cacheKeys } from "./cache-keys"
import { K8sCredentialError } from "./k8s-client"
import type { LiveEventIngest, LiveEventType, LiveSeverity } from "@/types/live"
import type { EventResource } from "@/types/event-envelope"

function needsBearerToken(apiServer: string): boolean {
  return apiServer.startsWith("https://")
}

/** True if the informer has a usable bearer token for `apiServer` right now — used both to decide whether to start and to log a clear disable reason instead of crashing on a production misconfiguration. */
function hasBearerToken(apiServer: string): boolean {
  if (!needsBearerToken(apiServer)) return false
  try {
    return getK8sBearerToken().length > 0
  } catch {
    return false
  }
}

let started = false
let informerAbortController: AbortController | null = null
const LEASE_TTL_MS = 15_000
const LEASE_RENEW_MS = LEASE_TTL_MS / 3
// Keep partial watch lines bounded; an oversized line is discarded whole.
const WATCH_BUFFER_LIMIT = 1024 * 1024
type InformerOwnerState = "owner" | "standby" | "local-fallback" | "stopped"
const informerMetrics = { ownerState: "stopped" as InformerOwnerState, leaseAcquisitions: 0, leaseLosses: 0, reconnects: 0, resyncs410: 0, droppedByBackpressure: 0 }
const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export function getLiveK8sInformerStatus() {
  return { ...informerMetrics }
}

function newOwnerToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

export function stopLiveK8sInformerForTesting(): void {
  started = false
  if (informerAbortController) {
    informerAbortController.abort()
    informerAbortController = null
  }
  Object.assign(informerMetrics, { ownerState: "stopped", leaseAcquisitions: 0, leaseLosses: 0, reconnects: 0, resyncs410: 0, droppedByBackpressure: 0 })
}

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
  if (needsBearerToken(apiServer)) {
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
    source_event_id: ev.metadata?.uid && ev.metadata?.resourceVersion
      ? `${ev.metadata.uid}:${ev.metadata.resourceVersion}`
      : undefined,
  }
}

async function listLatestEvent(apiServer: string, signal?: AbortSignal): Promise<{ resourceVersion: string; items: K8sEvent[] }> {
  const res = await fetch(`${apiServer}/api/v1/events?limit=1`, { headers: headers(apiServer), signal })
  if (!res.ok) {
    // Rotated/expired token — drop the cache so the next retry (outer loop's
    // backoff in startLiveK8sInformer) re-reads the projected token file.
    if (res.status === 401) invalidateK8sBearerToken()
    if (res.status === 401 || res.status === 403) throw new K8sCredentialError(res.status, "/api/v1/events?limit=1")
    throw new Error(`list events ${res.status}`)
  }
  const body = (await res.json()) as { metadata?: { resourceVersion?: string }; items?: K8sEvent[] }
  return { resourceVersion: body.metadata?.resourceVersion ?? "0", items: body.items ?? [] }
}

/** Cold start / lease failover: resourceVersion is process-local, so there is
 * nothing to catch up on — start watching from now and deliberately skip
 * existing history. */
async function getLatestResourceVersion(apiServer: string, signal?: AbortSignal): Promise<string> {
  return (await listLatestEvent(apiServer, signal)).resourceVersion
}

async function ingestK8sEvent(ev: K8sEvent): Promise<void> {
  const ingest = toIngest(ev)
  if (!ingest) return
  if (ingest.source_event_id) {
    const claimed = await claimIdempotencyKey(
      getIdempotencyStore(),
      `source-event:${ingest.source}:${ingest.source_event_id}`,
      "1",
      3600,
    )
    if (claimed) return
  }
  void pushEvent(ingest).catch(() => {})
}

/** Resync a complete bounded paginated snapshot before advancing the watch.
 * Partial snapshots fail/retry visibly rather than silently skipping events. */
async function resyncAfterGone(apiServer: string, signal?: AbortSignal): Promise<string> {
  let snapshot
  try {
    snapshot = await listEventsForResync(apiServer, headers(apiServer), signal)
  } catch (error) {
    if (error instanceof Error && error.message === "resync events 401") invalidateK8sBearerToken()
    throw error
  }
  const { resourceVersion, items } = snapshot
  for (const item of items) {
    await ingestK8sEvent(item)
  }
  return resourceVersion
}

/** Runs one watch connection; returns the last-seen resourceVersion when it ends. */
async function watchOnce(apiServer: string, resourceVersion: string, signal?: AbortSignal): Promise<string> {
  const url =
    `${apiServer}/api/v1/events` +
    `?watch=1&resourceVersion=${encodeURIComponent(resourceVersion)}&timeoutSeconds=300`
  const res = await fetch(url, { headers: headers(apiServer), signal })
  if (!res.ok || !res.body) {
    if (res.status === 401) invalidateK8sBearerToken()
    if (res.status === 401 || res.status === 403) throw new K8sCredentialError(res.status, "/api/v1/events?watch=1")
    throw new Error(`watch events ${res.status}`)
  }

  const reader = res.body.getReader()
  const onAbort = () => { void reader.cancel() }
  signal?.addEventListener("abort", onAbort, { once: true })
  const decoder = new TextDecoder()
  let buf = ""
  let skippingOversizedLine = false
  let rv = resourceVersion
  try {
    for (;;) {
      if (signal?.aborted) break
      const { value, done } = await reader.read()
      if (done || signal?.aborted) break
      buf += decoder.decode(value, { stream: true })
      if (skippingOversizedLine) {
        const newline = buf.indexOf("\n")
        if (newline < 0) {
          buf = ""
          continue
        }
        buf = buf.slice(newline + 1)
        skippingOversizedLine = false
      }
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
          // Idempotency-keyed the same way resyncAfterGone's relisted items are,
          // via the same `source-event:${source}:${source_event_id}` shape
          // /api/events/ingest dedups on — so an event delivered both via this
          // informer and via the ingest webhook (or via both watch and a 410
          // relist) is deduped against the other, not just against itself.
          if (evt.type === "ADDED") await ingestK8sEvent(obj)
        } catch {
          // malformed line — skip
        }
      }
      // Drain complete events before bounding the remaining partial tail. This
      // preserves bursts whose total size exceeds the limit but whose lines do not.
      if (buf.length > WATCH_BUFFER_LIMIT) {
        buf = ""
        skippingOversizedLine = true
        informerMetrics.droppedByBackpressure++
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {
      // ignore
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
  const controller = new AbortController()
  informerAbortController = controller
  const { signal } = controller
  console.log("[live-k8s-informer] starting lease-coordinated core/v1 Events watch")

  void (async () => {
    let rv = "0"
    let backoff = 1000
    let wasOwner = false
    // Set only by the 410 branch below; consumed (and reset) the moment rv
    // === "0" is next resolved, so it distinguishes "must relist to avoid
    // skipping events" from a plain cold start/failover, which has nothing to
    // catch up on (portal#178 gap 3).
    let resyncDueTo410 = false
    for (;;) {
      if (signal.aborted) break
      const token = newOwnerToken()
      let valkey: ReturnType<typeof getValkey> | null = null
      let leaseHeld = false
      let leaseUnavailable = false
      try {
        valkey = getValkey()
        leaseHeld = (await valkey.set(cacheKeys.liveK8sInformerLease(), token, "PX", LEASE_TTL_MS, "NX")) === "OK"
      } catch {
        leaseUnavailable = true
        informerMetrics.ownerState = "local-fallback"
        console.warn("[live-k8s-informer] Valkey lease unavailable; watching locally on this replica")
      }
      if (valkey && !leaseHeld && !leaseUnavailable) {
        wasOwner = false
        resyncDueTo410 = false // losing the lease invalidates any in-flight resync intent
        informerMetrics.ownerState = "standby"
        await new Promise((resolve) => setTimeout(resolve, LEASE_RENEW_MS))
        continue
      }
      if (leaseHeld) {
        informerMetrics.leaseAcquisitions++
        informerMetrics.ownerState = "owner"
      } else if (informerMetrics.ownerState !== "local-fallback") {
        informerMetrics.ownerState = "local-fallback"
      }
      if (leaseHeld) {
        if (!wasOwner) rv = "0" // resourceVersion is process-local; relist after failover.
        wasOwner = true
      } else {
        wasOwner = false
      }
      const watchController = new AbortController()
      const abortWatch = () => watchController.abort()
      signal.addEventListener("abort", abortWatch, { once: true })
      const renewTimer = leaseHeld ? setInterval(() => {
        void valkey!.eval(RENEW_SCRIPT, 1, cacheKeys.liveK8sInformerLease(), token, LEASE_TTL_MS).then((renewed) => {
          if (Number(renewed) !== 1) {
            informerMetrics.leaseLosses++
            informerMetrics.ownerState = "standby"
            watchController.abort()
          }
        }).catch(() => {
          informerMetrics.leaseLosses++
          informerMetrics.ownerState = "local-fallback"
          watchController.abort()
        })
      }, LEASE_RENEW_MS) : null
      try {
        if (rv === "0") {
          rv = resyncDueTo410
            ? await resyncAfterGone(apiServer, watchController.signal)
            : await getLatestResourceVersion(apiServer, watchController.signal)
          resyncDueTo410 = false
        }
        if (signal.aborted || watchController.signal.aborted) break
        rv = await watchOnce(apiServer, rv, watchController.signal)
        if (!signal.aborted) informerMetrics.reconnects++
        backoff = 1000 // clean cycle — reset backoff
      } catch (e) {
        if (signal.aborted) break
        const msg = e instanceof Error ? e.message : String(e)
        if (watchController.signal.aborted) continue
        informerMetrics.reconnects++
        // 410 Gone: resourceVersion too old — relist (not a plain cold start)
        // so events since the expired watch aren't silently skipped.
        if (msg.includes("410")) {
          informerMetrics.resyncs410++
          rv = "0"
          resyncDueTo410 = true
          continue
        }
        console.warn("[live-k8s-informer] watch error, retrying:", msg)
        await new Promise((r) => setTimeout(r, backoff))
        if (signal.aborted) break
        backoff = Math.min(backoff * 2, 30_000)
      } finally {
        signal.removeEventListener("abort", abortWatch)
        if (renewTimer) clearInterval(renewTimer)
        if (leaseHeld && valkey) {
          try { await valkey.eval(RELEASE_SCRIPT, 1, cacheKeys.liveK8sInformerLease(), token) } catch { /* TTL expires if release is unavailable. */ }
        }
      }
    }
    informerMetrics.ownerState = "stopped"
  })()
}
