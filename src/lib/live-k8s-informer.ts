/**
 * Kubernetes informer for the live event stream (`/live`).
 *
 * Watches core/v1 Events cluster-wide and forwards them to the live stream via
 * pushEvent(). Started once from instrumentation.ts on the Node.js runtime.
 * Previously this was a TODO stub that was never invoked, so `/live` had no event
 * source at all — the page could only ever show what the /api/events/ingest webhook
 * received (nothing was posting to it).
 */
import { K8S_API_SERVER } from "./config"
import { pushEvent } from "./live-stream"
import type { LiveEventIngest, LiveEventType, LiveSeverity } from "@/types/live"

const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

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

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (USE_BEARER) h.Authorization = `Bearer ${K8S_TOKEN}`
  return h
}

function toIngest(ev: K8sEvent): LiveEventIngest | null {
  const reason = ev.reason ?? ""
  const isWarning = ev.type === "Warning"
  if (!isWarning && !NORMAL_REASON_ALLOW.has(reason)) return null

  const io = ev.involvedObject ?? {}
  const severity: LiveSeverity = isWarning ? "warning" : "info"
  const type: LiveEventType = io.kind === "Node" ? "node" : "custom"
  // Prefix `namespace=<ns>` so the SSE route's role/namespace filter can scope it.
  const nsTag = io.namespace ? `namespace=${io.namespace} ` : ""
  const objRef = `${io.kind ?? "Object"} ${io.name ?? ""}`.trim()
  return {
    type,
    severity,
    source: "kubernetes",
    title: `${objRef} — ${reason || "Event"}`.slice(0, 200),
    description: `${nsTag}${ev.message ?? ""}`.slice(0, 500),
  }
}

async function getLatestResourceVersion(): Promise<string> {
  const res = await fetch(`${K8S_API_SERVER}/api/v1/events?limit=1`, { headers: headers() })
  if (!res.ok) throw new Error(`list events ${res.status}`)
  const body = (await res.json()) as { metadata?: { resourceVersion?: string } }
  return body.metadata?.resourceVersion ?? "0"
}

/** Runs one watch connection; returns the last-seen resourceVersion when it ends. */
async function watchOnce(resourceVersion: string): Promise<string> {
  const url =
    `${K8S_API_SERVER}/api/v1/events` +
    `?watch=1&resourceVersion=${encodeURIComponent(resourceVersion)}&timeoutSeconds=300`
  const res = await fetch(url, { headers: headers() })
  if (!res.ok || !res.body) throw new Error(`watch events ${res.status}`)

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
  if (!USE_BEARER) {
    console.warn("[live-k8s-informer] K8S_SA_TOKEN not set — live event informer disabled")
    return
  }
  started = true
  console.log("[live-k8s-informer] starting core/v1 Events watch")

  void (async () => {
    let rv = "0"
    let backoff = 1000
    for (;;) {
      try {
        if (rv === "0") rv = await getLatestResourceVersion()
        rv = await watchOnce(rv)
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
