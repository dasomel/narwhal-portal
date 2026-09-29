# Architecture

Narwhal Portal is the user-facing control surface for a Narwhal platform. It presents cluster, delivery, security, cost and observability data through one domain-oriented UI without replacing the systems that remain authoritative for that data.

## System context

```mermaid
flowchart LR
    U["Platform user"] --> W["Next.js portal"]
    W --> B["Server routes and domain API"]
    B --> K["Kubernetes API"]
    B --> G["Argo CD"]
    B --> O["Metrics · logs · traces"]
    B --> I["Keycloak / OIDC"]
    N["Narwhal GitOps"] -. deploys .-> W
```

The portal reads and orchestrates platform APIs. Kubernetes, Argo CD, the identity provider and observability backends remain systems of record.

## Application layers

| Layer | Source | Responsibility |
|---|---|---|
| Routes and layouts | `src/app/` | Dashboard navigation, login and server-rendered pages |
| API boundary | `src/app/api/` | Health, cluster, catalog, templates, scorecards, cost, security and telemetry endpoints |
| UI composition | `src/components/` | Reusable visual and domain components |
| Client state | `src/hooks/`, `src/lib/` | Fetching, normalization, auth helpers and domain clients |
| Contracts | `src/types/`, `protos/` | TypeScript and flow/observer/relay integration contracts |
| Runtime packaging | `deploy/`, `config/` | Container deployment and environment-specific configuration |

## Request flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Portal UI
    participant API as Next.js API route
    participant Source as Platform API
    User->>UI: Open domain view
    UI->>API: Request normalized data
    API->>Source: Authenticate and query
    Source-->>API: Authoritative response
    API-->>UI: Portal domain model
    UI-->>User: Status, action or evidence
```

## Trust and deployment boundaries

- Browser code never receives Kubernetes service-account credentials.
- Server routes are the integration boundary for cluster and platform APIs.
- OIDC establishes user identity; authorization is still checked at the called service.
- Runtime configuration is injected through deployment resources, not bundled into the UI.
- Correlated data with uncertain relationships is labeled instead of presented as authoritative.

## Caching contract

Every Valkey cache key (`src/lib/valkey.ts`'s `cacheGet`/`cacheSet`/`cacheDel`) is built from
explicit named dimensions in [`src/lib/cache-keys.ts`](../src/lib/cache-keys.ts) — namespace,
schema version, `cluster_id` (via `clusterCacheKey`, `src/lib/cluster-registry.ts`), and
authorization scope (via `EffectiveScope.fingerprint`, `src/lib/scope.ts`) — rather than a
hand-written template string per route. `CACHE_NAMESPACES` in that module is the full documented
contract (dimensions / TTL / invalidation trigger / whether a partial provider response is ever
cached) for every namespace in the codebase, and
[`cache-keys.contract.test.ts`](../src/lib/cache-keys.contract.test.ts) enforces it: every
namespace whose cached value differs by caller identity, team, role, or cluster must carry a
matching dimension, and no namespace caches a failed/partial provider fetch.

`src/lib/argocd.ts`, `src/lib/gitea.ts`, `src/lib/http-client.ts`, and `src/lib/keycloak-client.ts`
(`KEYCLOAK_CACHE_KEYS`, already centralized per #49) own their own key construction and are
referenced in the registry for completeness rather than migrated into this module.

## Outbound HTTP transport policy

Outbound HTTP calls to platform dependencies (Argo CD, Gitea, Prometheus, Keycloak, APISIX,
Kubernetes API, OpenBao, Alertmanager, Falco/Loki) are standardized through the shared transport
client in [`src/lib/http-client.ts`](../src/lib/http-client.ts).

Detailed transport reference and matrix: [`docs/outbound-http-policy.md`](./outbound-http-policy.md).

### Transport guarantees and error model

- **Transport failures (`HttpClientError`)**: Transport-level failures throw `HttpClientError`
  ([`src/lib/http-client.ts:98-116`](../src/lib/http-client.ts#L98-L116)) with normalized
  `kind: HttpClientErrorKind` (`"timeout" | "network" | "aborted"`,
  [`src/lib/http-client.ts:90`](../src/lib/http-client.ts#L90)).
- **HTTP status responses**: Non-retried HTTP status outcomes (including 401, 403, 500, and
  exhausted 429/502/503/504) return the `Response` object
  ([`src/lib/http-client.ts:350-353, 413`](../src/lib/http-client.ts#L350-L353)). Callers evaluate
  `response.ok` or `response.status` according to domain requirements.
- **Redaction**: URL query parameters and user credentials (`scheme://user:pass@`) are stripped
  via `redactUrl()` ([`src/lib/http-client.ts:122-134`](../src/lib/http-client.ts#L122-L134)). Headers
  (such as `Authorization` or `X-Vault-Token`) are never leaked into `HttpClientError.message`, but
  the original runtime error is preserved as `cause` ([`src/lib/http-client.ts:114, 425`](../src/lib/http-client.ts#L114));
  callers must not log `cause` wholesale if it can carry sensitive data.
- **Deadline-bounded body reads**: `fetchWithPolicy` records remaining attempt time
  `Math.max(0, timeoutMs - elapsed)` in `bodyDeadlines`
  ([`src/lib/http-client.ts:252, 412-413`](../src/lib/http-client.ts#L252)). Bodies read via
  `readJsonWithPolicy` ([`src/lib/http-client.ts:338`](../src/lib/http-client.ts#L338)) or
  `readTextWithPolicy` ([`src/lib/http-client.ts:343`](../src/lib/http-client.ts#L343)) must complete
  within that budget; stalled streams are aborted and throw `kind: "timeout"`.
- **Response byte-size limits**: Body-read time is deadline-bounded; response byte sizes are
  currently unbounded at the transport client layer
  ([`src/lib/http-client.ts:26-27`](../src/lib/http-client.ts#L26-L27)).
- **Circuit breaker**: Per-provider circuit breakers are not implemented in this layer
  ([`src/lib/http-client.ts:27-28`](../src/lib/http-client.ts#L27-L28)).

### Timeout and retry policy

Outbound HTTP calls routed through `fetchWithPolicy` enforce unified per-attempt deadlines (ranging from 2s cluster probes to 60s Kubernetes batch queries, with a 10s default) covering connection, headers, and remaining body streaming. Idempotent requests (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) automatically retry on transient network errors and 429/502/503/504 status codes up to 3 attempts with full-jitter exponential backoff, cancelling unread response bodies before retry. Non-idempotent mutations, 401/403/500 statuses, and timed-out requests are never retried. For full per-caller timeout classes, constants, and the complete retry matrix, see [`docs/outbound-http-policy.md`](outbound-http-policy.md) (or [한국어](outbound-http-policy-ko.md)).

## Live event pipeline

The live event path stores a bounded replay ring in Valkey and publishes each event on a
dedicated pub/sub channel. The SSE route subscribes before reading the replay snapshot, then
uses the snapshot's high-water ID to discard overlap between replay and live delivery.

| Condition | Behavior |
|---|---|
| Cursor is retained | Replay events strictly after the cursor, then continue live delivery |
| Cursor predates the retained ring | Send `replay-gap` with `state: "gap"`; the client must refresh its snapshot |
| Cursor cannot be established | Send `replay-gap` with `state: "unknown"`; the client must refresh its snapshot |
| Valkey is unavailable | Keep a process-local ring and IDs for best-effort delivery; events can be lost on restart or replica change |

The Valkey replay ring retains the newest 1,000 events. Ordering and replay boundaries use
only the integer from the shared Valkey `INCR` counter. If `INCR` fails, the publisher uses a
`d-<epoch-ms>-<local-seq>` ID and still attempts to persist and publish the event. Degraded IDs
are non-comparable with shared counters; they replay only when the exact ID is still in the
same process's in-memory ring. Other degraded cursors are reported as `unknown`. Client abort
signals end the subscription and release its pub/sub listener and connection.

The admin-only `/api/health/dependencies` response includes in-process `liveStream` metrics:

| Metric | Meaning |
|---|---|
| `acceptedIngests` | Ingest requests accepted and sent to the live pipeline |
| `duplicateIngests` | Requests rejected as duplicates by idempotency |
| `incrFailures` | Failures obtaining the shared Valkey event ID with `INCR`; during a full Valkey outage, one `pushEvent` increments this and `writeFailures`, so summing them overstates distinct events |
| `writeFailures` | Failures writing the replay ring or publishing the event; during a full Valkey outage, one `pushEvent` increments this and `incrFailures`, so summing them overstates distinct events |
| `subscribeFailures` | Failures subscribing an SSE consumer to pub/sub |
| `degradedEntries` | Transitions from healthy into degraded mode |
| `recoveries` | Transitions from degraded back to healthy |
| `replayInWindow` | Replay requests resolved within the retained window |
| `replayGaps` | Replay requests whose cursor predates retained events |
| `replayUnknown` | Replay requests whose cursor could not be established |
| `connectedClients` | Current SSE clients connected to this process (gauge) |
| `disconnectCleanups` | SSE client disconnects that ran subscription cleanup |

All metrics except `connectedClients` are monotonic counters. They are process-local, reset on
process restart, and report only the replica serving the admin request. Prometheus scraping and
aggregation are future cluster-side work; this endpoint does not provide cluster-wide totals.

### Offline / air-gap behavior (portal#13)

What happens, derived from code, when each upstream the live pipeline depends on is unreachable —
proven by [`src/lib/live-outage-recovery.test.ts`](../src/lib/live-outage-recovery.test.ts), which
drives the real ingest/watch/replay code through a combined Valkey outage and a K8s watch
disconnect with no network:

| Unreachable dependency | What happens | Bound |
|---|---|---|
| Kubernetes API (list or watch) | `startLiveK8sInformer` disables at startup with no throw if no bearer token is obtainable ([`live-k8s-informer.ts:25-32`](../src/lib/live-k8s-informer.ts#L25-L32)); a running watch retries with exponential backoff, capped, and resets on a clean cycle ([`live-k8s-informer.ts:307-321`](../src/lib/live-k8s-informer.ts#L307-L321)); a `410 Gone` triggers an immediate resync instead of a backoff sleep ([`live-k8s-informer.ts:312-317`](../src/lib/live-k8s-informer.ts#L312-L317)) by only re-reading the *current* resourceVersion, not relisting what changed since the expired one ([`live-k8s-informer.ts:136-146`](../src/lib/live-k8s-informer.ts#L136-L146), call site [`302`](../src/lib/live-k8s-informer.ts#L302) — see gap 3 below); on a `401` the cached token is invalidated before the retry, on a `403` it is not (a `403` is a permissions problem, not a stale token) — both raise `K8sCredentialError` ([`live-k8s-informer.ts:141`](../src/lib/live-k8s-informer.ts#L141) 401-only invalidation, [`142`](../src/lib/live-k8s-informer.ts#L142) shared throw for 401/403, mirrored in `watchOnce` at [`156`](../src/lib/live-k8s-informer.ts#L156)/[`157`](../src/lib/live-k8s-informer.ts#L157)) | Backoff caps at 30s ([`live-k8s-informer.ts:321`](../src/lib/live-k8s-informer.ts#L321)); an oversized partial watch line is discarded, not buffered without limit ([`live-k8s-informer.ts:39`](../src/lib/live-k8s-informer.ts#L39), [`216-222`](../src/lib/live-k8s-informer.ts#L216-L222)) |
| Valkey — informer lease | Acquiring the lease throws → this replica watches locally without exclusivity (`ownerState: "local-fallback"`) instead of stopping ([`live-k8s-informer.ts:259-266`](../src/lib/live-k8s-informer.ts#L259-L266)) | Lease TTL 15s, renewed every 5s while healthy ([`live-k8s-informer.ts:36-37`](../src/lib/live-k8s-informer.ts#L36-L37)) |
| Valkey — event ring / pub-sub (`pushEvent`) | `INCR` failing mints a process-local `d-<epoch-ms>-<seq>` id instead of dropping the event; the LPUSH/LTRIM/PUBLISH pipeline failing still keeps the event in the process-local ring ([`live-stream.ts:11`](../src/lib/live-stream.ts#L11), [`88-96`](../src/lib/live-stream.ts#L88-L96)) | Local ring bounded to the newest 1,000 events, same as the shared ring ([`live-stream.ts:7`](../src/lib/live-stream.ts#L7), [`109-110`](../src/lib/live-stream.ts#L109-L110)); it is process memory only — lost on process exit or restart, not just "on replica change" |
| Valkey — idempotency store | `ValkeyIdempotencyStore.claim`/`fulfill` fall back to an in-memory store instead of failing the ingest ([`idempotency.ts:107-123`](../src/lib/idempotency.ts#L107-L123)) | In-memory fallback capped at 5,000 keys with TTL sweep ([`idempotency.ts:44`](../src/lib/idempotency.ts#L44), [`48-70`](../src/lib/idempotency.ts#L48-L70)). TTL itself differs by caller: the shared default is 24h ([`idempotency.ts:12`](../src/lib/idempotency.ts#L12)), but the K8s informer's own dedup claim passes an explicit 1h TTL instead ([`live-k8s-informer.ts:205`](../src/lib/live-k8s-informer.ts#L205)) |
| Valkey — SSE subscription | A subscriber that can't open pub/sub ends the live tail immediately after reporting degraded status; the connection stays open on heartbeats only, no live events until the client reconnects ([`live-stream.ts:172-176`](../src/lib/live-stream.ts#L172-L176)) | n/a |

What a client sees on reconnect with `Last-Event-ID` (`src/app/api/events/stream/route.ts:33`,
[`83-86`](../src/app/api/events/stream/route.ts#L83-L86)): events strictly after the cursor when
it is still in the retained window; a `replay-gap` control event (`state: "gap"`) when the cursor
predates the ring; `state: "unknown"` when the cursor can't be placed at all (malformed, or a
degraded id from a different process). A numeric cursor whose window is still retained can,
however, return `gap: false` / `unknown: false` while silently missing any `d-` (degraded-id)
events minted during a same-process outage — see gap 1 below; that specific path is not covered
by the "none of these three paths silently drops an event" guarantee above.

Three gaps exist beyond that summary, proven by [`live-outage-recovery.test.ts`](../src/lib/live-outage-recovery.test.ts)'s
`it.fails` cases and tracked as [dasomel/narwhal-portal#178](https://github.com/dasomel/narwhal-portal/issues/178).
**Not fixed by this commit** — production behavior is unchanged; each `it.fails` asserts the
correct behavior so it starts failing (signaling a fix) once #178 lands:

- **Gap 1 — numeric-cursor blind spot for same-process degraded events.** An event minted while
  Valkey's event ring was unreachable (a `d-` id) is never retroactively merged into the shared
  ring once Valkey recovers. A client reconnecting with a real, pre-outage numeric `Last-Event-ID`
  gets a replay that looks complete (`gap: false`, `unknown: false`) but silently omits any event
  that only ever lived in the local ring — `replayAfter` only reads the shared Valkey ring once
  Valkey answers again ([`live-stream.ts:125-134`](../src/lib/live-stream.ts#L125-L134),
  [`157-158`](../src/lib/live-stream.ts#L157-L158)). The event is not gone from the process — the
  exact-degraded-id replay branch still finds it ([`live-stream.ts:151-156`](../src/lib/live-stream.ts#L151-L156))
  — but only a client that already holds that exact `d-` cursor (e.g. one that stayed connected
  through the outage) can reach it.
- **Gap 2 — idempotency does not survive an outage/recovery cycle.** A claim recorded only in the
  in-memory fallback while Valkey was unreachable is not consulted once Valkey recovers:
  `ValkeyIdempotencyStore.claim` only checks Valkey's own key when Valkey answers
  ([`idempotency.ts:107-123`](../src/lib/idempotency.ts#L107-L123)). A redelivery of the same
  event (e.g. from the K8s informer's post-`410` relist) after recovery is treated as new and
  re-ingested, rather than deduplicated against the outage-time claim.
- **Gap 3 — a 410 resync skips events instead of relisting them.** After a `410 Gone`, the outer
  loop resets the cursor and calls `getLatestResourceVersion` ([`live-k8s-informer.ts:302`](../src/lib/live-k8s-informer.ts#L302)),
  which issues `GET /api/v1/events?limit=1` and reads only `metadata.resourceVersion` from the
  response — the `items` it returns are never read or forwarded
  ([`live-k8s-informer.ts:136-146`](../src/lib/live-k8s-informer.ts#L136-L146)). Any events that
  occurred between the expired watch's last-seen resourceVersion and this fresh one are neither
  ingested nor flagged anywhere (no metric, no `replay-gap`) — they are simply never looked at.

## Relationship to Narwhal

This repository owns portal code and packaging. The [Narwhal repository](https://github.com/dasomel/narwhal) owns cluster provisioning, GitOps applications, gateways, identity and platform services. A new cluster capability therefore needs a portal contract here and deployment/configuration in Narwhal separately.
