# Outbound HTTP Transport Policy

English | [한국어](outbound-http-policy-ko.md)

This document specifies the outbound HTTP transport policy implemented by the shared client
[`src/lib/http-client.ts`](../src/lib/http-client.ts) (portal#48). All OSS provider adapters
(Argo CD, Gitea, Prometheus, Keycloak, APISIX, Kubernetes API, OpenBao, Alertmanager, Falco/Loki)
use this client instead of calling bare `fetch()`, unifying timeout management, bounded retries,
distributed correlation, body deadlines, and sensitive credential redaction.

## Architecture and Guarantees

### 1. Error Model and Classification
- **Transport errors (`HttpClientError`)**: Transport disruptions throw `HttpClientError`
  ([`src/lib/http-client.ts:98-116`](../src/lib/http-client.ts#L98-L116)). Its `kind` property
  ([`src/lib/http-client.ts:90`](../src/lib/http-client.ts#L90)) is strictly normalized into:
  - `"timeout"`: Request aborted because attempt duration exceeded `timeoutMs` or body read exceeded remaining deadline.
  - `"network"`: Network or socket-level error (e.g. `TypeError: fetch failed`, `ECONNRESET`, DNS resolution failure).
  - `"aborted"`: Caller-supplied `AbortSignal` was aborted by the inbound consumer.
  - `"response-too-large"`: The decoded JSON/text body exceeds its configured byte budget.
- **HTTP status responses**: Non-retried HTTP status responses (including 401, 403, 500, and exhausted
  429/502/503/504) return the standard `Response` object ([`src/lib/http-client.ts:350-353, 413`](../src/lib/http-client.ts#L350-L353)).
  Domain adapters handle HTTP statuses explicitly (e.g., checking `res.status === 401`).
- **Circuit breaker**: Per-provider circuit breakers and health metrics are not implemented in this
  slice ([`src/lib/http-client.ts:27-28`](../src/lib/http-client.ts#L27-L28)).

### 2. URL and Credential Redaction
- `HttpClientError.url` and `HttpClientError.message` are guaranteed never to include query parameters
  or user credentials (`scheme://user:pass@`) via `redactUrl()`
  ([`src/lib/http-client.ts:122-134`](../src/lib/http-client.ts#L122-L134)).
- Request headers (such as `Authorization: Bearer ...` or `X-Vault-Token`) are never incorporated
  into error messages (`HttpClientError.message` only incorporates the HTTP kind and redacted URL,
  [`src/lib/http-client.ts:93-115`](../src/lib/http-client.ts#L93-L115)). However, the underlying
  runtime error is preserved directly as `HttpClientError.cause`
  ([`src/lib/http-client.ts:114, 425`](../src/lib/http-client.ts#L114)). Callers must not log or expose
  the `cause` wholesale if the underlying fetch or environment error could carry sensitive data.

### 3. Header and Body Deadlines
- `fetchWithPolicy` enforces a per-attempt deadline `timeoutMs`
  ([`DEFAULT_TIMEOUT_MS = 10_000`](../src/lib/http-client.ts#L51)) covering socket connection and response headers.
- Once headers arrive, the remaining budget `remainingMs = Math.max(0, timeoutMs - elapsed)` is recorded
  in `bodyDeadlines` ([`src/lib/http-client.ts:252, 412-413`](../src/lib/http-client.ts#L252)).
- Body parsing via `readJsonWithPolicy` ([`src/lib/http-client.ts:338`](../src/lib/http-client.ts#L338)) or
  `readTextWithPolicy` ([`src/lib/http-client.ts:343`](../src/lib/http-client.ts#L343)) acquires a stream reader
  and bounds payload reception to `remainingMs`. If the body stalls, the reader is cancelled, the underlying stream
  is aborted, and `HttpClientError(kind: "timeout")` is thrown.
- **Response byte-size limits**: Policy JSON/text readers retain at most **8 MiB of decoded bytes** by
  default, independent of `Content-Length` (which may be absent, wrong, or compressed). The first
  chunk exceeding the limit cancels the reader and throws `HttpClientError(kind: "response-too-large")`.
  This body failure is never retried. An adapter with a documented larger bounded inventory can pass
  `maxResponseBytes` as a positive safe integer to `fetchWithPolicy`; there is no unlimited setting.
  Exact-limit bodies are accepted. Native `response.json()`/`.text()`, independently constructed
  Responses, and the Kubernetes long-lived watch remain explicit exceptions to these policy readers.
  Acceptance evidence: `src/lib/http-client.size.test.ts` covers chunked responses with a misleading
  length, UTF-8 byte counting, exact boundaries, defaults, invalid overrides, and cancellation.

### 4. Correlation Propagation
- Inbound correlation IDs are extracted via `correlationIdFrom()` ([`src/lib/http-client.ts:168`](../src/lib/http-client.ts#L168)),
  checking `x-correlation-id` followed by `x-request-id`.
- If present, `fetchWithPolicy` propagates this as `X-Correlation-Id` ([`src/lib/http-client.ts:48, 178-197`](../src/lib/http-client.ts#L48)).
  If absent, no header is synthesized.

---

## Timeout Classes

`fetchWithPolicy` enforces a single `timeoutMs` budget per attempt. The table below lists the timeout
classes used across `src/lib/` domain providers:

| Timeout class | Connect + headers | Body read | Total budget per attempt | Used by (callers in `src/lib/`) | Constants / source citations |
|---|---|---|---|---|---|
| **Cluster probe** | Up to 2,000ms | Remaining of 2,000ms | 2,000ms | Kubernetes cluster version health probe | [`src/lib/domain/cluster.ts:221`](../src/lib/domain/cluster.ts#L221) (`timeoutMs = 2000`) |
| **Fast probe / Telemetry read** | Up to 5,000ms | Remaining of 5,000ms | 5,000ms | Argo CD application reads (`argoFetch`)<br>Gitea commit timestamp (`getCommitTimestamp`)<br>Alertmanager silences list (`getAlertmanagerSilences`)<br>APISIX routes query (`getRoutes`)<br>Prometheus instant query (cost)<br>Prometheus range query (cost)<br>Loki logs query (Falco events)<br>Kubernetes node status probe (Hero)<br>Dependency health probes (`probeHttpDependency`) | [`src/lib/argocd.ts:81`](../src/lib/argocd.ts#L81) (`timeoutMs = 5000`)<br>[`src/lib/gitea.ts:270`](../src/lib/gitea.ts#L270) (`timeoutMs: 5000`)<br>[`src/lib/alertmanager.ts:96`](../src/lib/alertmanager.ts#L96) (`timeoutMs: 5000`)<br>[`src/lib/apisix-client.ts:65`](../src/lib/apisix-client.ts#L65) (`timeoutMs: 5000`)<br>[`src/lib/cost.ts:193, 195`](../src/lib/cost.ts#L193) (`PROM_TIMEOUT_MS = 5000`, `PROM_RANGE_TIMEOUT_MS = 5000`)<br>[`src/lib/falco.ts:99`](../src/lib/falco.ts#L99) (`timeoutMs: 5000`)<br>[`src/lib/hero.ts:202`](../src/lib/hero.ts#L202) (`timeoutMs: 5000`)<br>[`src/lib/dependency-health.ts:166`](../src/lib/dependency-health.ts#L166) (`DEFAULT_PROBE_TIMEOUT_MS = 5000`) |
| **Standard / Default** | Up to 10,000ms | Remaining of 10,000ms | 10,000ms | Client default fallback<br>Argo CD sync (`syncArgoApp`) & rollback (`rollbackArgoApp`)<br>Gitea API mutations (`api`)<br>APISIX route plugin toggle (`toggleRoute`)<br>Prometheus standard queries (`queryPrometheusVector`, range)<br>Service graph Prometheus queries<br>Alertmanager silence creation / expiry<br>Keycloak admin token & operations<br>OpenBao auth login & KV secret reads/writes<br>Kubernetes Job delete | [`src/lib/http-client.ts:51`](../src/lib/http-client.ts#L51) (`DEFAULT_TIMEOUT_MS = 10_000`)<br>[`src/lib/argocd.ts:251, 286`](../src/lib/argocd.ts#L251)<br>[`src/lib/gitea.ts:93`](../src/lib/gitea.ts#L93)<br>[`src/lib/apisix-client.ts:85`](../src/lib/apisix-client.ts#L85)<br>[`src/lib/prometheus.ts:232, 361, 441`](../src/lib/prometheus.ts#L232)<br>[`src/lib/service-graph.ts:89`](../src/lib/service-graph.ts#L89)<br>[`src/lib/alertmanager.ts:38, 77`](../src/lib/alertmanager.ts#L38)<br>[`src/lib/keycloak-client.ts:93, 172`](../src/lib/keycloak-client.ts#L93)<br>[`src/lib/openbao.ts:136, 192, 202`](../src/lib/openbao.ts#L136)<br>[`src/lib/k8s-job-runner.ts:78`](../src/lib/k8s-job-runner.ts#L78) |
| **Kubernetes batch / Long-read** | Up to 60,000ms | Remaining of 60,000ms | 60,000ms | Kubernetes pagination & lists (`listBounded`)<br>Kubernetes generic resource queries (`getNamespaces`)<br>Kubernetes job runner API fetch (`k8sFetch`)<br>Compliance audit evaluation<br>Security scorecard inspection<br>Trivy vulnerability report fetching | [`src/lib/k8s-client.ts:48`](../src/lib/k8s-client.ts#L48) (`timeoutMs: 60_000`)<br>[`src/lib/k8s-job-runner.ts:52, 64`](../src/lib/k8s-job-runner.ts#L52)<br>[`src/lib/compliance.ts:33`](../src/lib/compliance.ts#L33)<br>[`src/lib/scorecard.ts:73`](../src/lib/scorecard.ts#L73)<br>[`src/lib/trivy.ts:22`](../src/lib/trivy.ts#L22) |
| **Kubernetes job execution budget** | Clamped 1s–10s per poll | Budget remaining | Max 300s total | Kubernetes asynchronous tuning/batch job execution | [`src/lib/k8s-job-runner.ts:133, 218`](../src/lib/k8s-job-runner.ts#L133) (`timeoutMs = 5 * 60_000`, `jobStatusPollTimeoutMs`) |

---

## Retry Policy Matrix

### Parameters and Constants
- **Max attempts**: `DEFAULT_MAX_ATTEMPTS = 3` ([`src/lib/http-client.ts:52`](../src/lib/http-client.ts#L52))
- **Base delay**: `DEFAULT_BASE_DELAY_MS = 200` ([`src/lib/http-client.ts:53`](../src/lib/http-client.ts#L53))
- **Max delay**: `DEFAULT_MAX_DELAY_MS = 5_000` ([`src/lib/http-client.ts:54`](../src/lib/http-client.ts#L54))
- **Backoff algorithm**: Full-jitter exponential backoff `Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))` ([`src/lib/http-client.ts:143-146`](../src/lib/http-client.ts#L143-L146))
- **Retry-After header**: For 429 responses, `Retry-After` header (delay seconds or HTTP-date) is honored, clamped to `maxDelayMs` ([`src/lib/http-client.ts:151-159`](../src/lib/http-client.ts#L151-L159))
- **Eligible HTTP methods**: `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` ([`IDEMPOTENT_METHODS`, src/lib/http-client.ts:32-38`](../src/lib/http-client.ts#L32-L38))
- **Retryable HTTP status codes**: `429`, `502`, `503`, `504` ([`RETRYABLE_STATUS`, src/lib/http-client.ts:46`](../src/lib/http-client.ts#L46))
- **Connection release**: Retried response bodies are cancelled via `cancelBody(response)` (`await response.body.cancel()`, [`src/lib/http-client.ts:238-245, 398`](../src/lib/http-client.ts#L238)) before backing off to prevent connection leaks.

### Matrix

| Operation Category | Failure Kind | Retried? | Attempts & Backoff | Rationale / Citation |
|---|---|---|---|---|
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | Network error / Connection reset (`ECONNRESET`, `TypeError: fetch failed`, DNS drop) | **Yes** | Up to 3 attempts. Full-jitter: `0..min(5s, 200ms * 2^(attempt-1))`. | Transient connection or network issue. [`src/lib/http-client.ts:421-424`](../src/lib/http-client.ts#L421-L424) |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | HTTP 429 Too Many Requests | **Yes** | Up to 3 attempts. Honors `Retry-After` header (clamped to 5s); otherwise full jitter. | Upstream explicitly requests rate-limit backoff. [`src/lib/http-client.ts:400-405`](../src/lib/http-client.ts#L400-L405) |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | HTTP 502 / 503 / 504 Gateway / Service errors | **Yes** | Up to 3 attempts. Cancels response body, full-jitter backoff: `0..min(5s, 200ms * 2^(attempt-1))`. | Transient upstream gateway or proxy issue. [`src/lib/http-client.ts:394-406`](../src/lib/http-client.ts#L394-L406) |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | HTTP 500 Internal Server Error / 501 Not Implemented | **No** | 1 attempt. Returns `Response(status: 500/501)`. | D1: 500/501 usually reflect upstream bugs rather than transient conditions; retrying triples load on a broken service. [`src/lib/http-client.ts:40-46`](../src/lib/http-client.ts#L40-L46) |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | HTTP 401 Unauthorized / 403 Forbidden | **No** (transport layer) | 1 attempt. Returns `Response(status: 401/403)`. | Auth/permission failure; blind retry is pointless. Domain callers re-authenticate when applicable (e.g. `k8s-client.ts:53`, `keycloak-client.ts:194`, `openbao.ts:201`). |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | Request timeout (`timeoutMs` elapsed) | **No** | 1 attempt. Throws `HttpClientError(kind: "timeout")`. | Timed-out requests are not retried to prevent cascading latency queues. [`src/lib/http-client.ts:420-425`](../src/lib/http-client.ts#L420-L425) |
| **Idempotent call** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) with default retry | Body read timeout (deadline elapsed mid-read) | **No** | 1 attempt. Cancels stream reader, throws `HttpClientError(kind: "timeout")`. | Prevents stalled body streams from hanging caller execution. [`src/lib/http-client.ts:321-325`](../src/lib/http-client.ts#L321-L325) |
| **Any operation** | Caller signal aborted (`signal.aborted === true`) | **No** | 1 attempt (or terminates after current backoff delay). Throws `HttpClientError(kind: "aborted")`. | Inbound caller cancelled the request; execution stops without retry. Retry backoff also observes the caller signal: cancellation clears its timer/listener immediately and prevents another request. [`src/lib/http-client.ts:416-425`](../src/lib/http-client.ts#L416-L425) |
| **Non-idempotent mutation** (`POST`, `PATCH`, non-standard methods) | Any failure (Network, 429, 5xx, timeout) | **No** | 1 attempt (`maxAttempts = 1`). Returns `Response` on HTTP status or throws `HttpClientError`. | Prevents duplicate state mutations (e.g. duplicate commits, duplicate build or sync triggers). [`src/lib/http-client.ts:373-374`](../src/lib/http-client.ts#L373-L374) |
| **Explicit single-shot callers** (`retry: false`, e.g. `K8S_POLICY`, `PROM_POLICY`, Keycloak admin PUT/DELETE, OpenBao login, Alertmanager silence delete) | Any failure (Network, 429, 5xx, timeout) | **No** | 1 attempt (`maxAttempts = 1`). | Prevents fighting Kubernetes API Priority & Fairness (APF), multiplying Prometheus scrape loads, or repeating administrative mutations. [`src/lib/k8s-client.ts:16`](../src/lib/k8s-client.ts#L16), [`src/lib/prometheus.ts:11`](../src/lib/prometheus.ts#L11), [`src/lib/keycloak-client.ts:182`](../src/lib/keycloak-client.ts#L182) |
