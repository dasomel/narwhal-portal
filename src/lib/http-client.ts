/**
 * Shared outbound HTTP client (portal#48): the transport-policy primitive every
 * OSS provider adapter (ArgoCD, Gitea, Prometheus, Keycloak, ...) should call
 * instead of `fetch()` directly, so timeout/retry/correlation/error-redaction
 * behavior is one policy instead of N ad-hoc `AbortController` + `setTimeout`
 * copies scattered across src/lib.
 *
 * Scope of this slice (see #48's AC list for the full roadmap):
 *  - per-call timeout via AbortSignal
 *  - bounded retry+backoff, gated on BOTH an idempotent method AND a retryable
 *    failure (network error, 502/503/504, 429 honoring Retry-After)
 *  - correlation/request-id propagation from an inbound Request/Headers when
 *    the caller has one
 *  - a typed error whose message/cause never includes header values, so a
 *    caller can log it directly without redacting Authorization by hand
 *
 * Left open, not attempted here: TLS-verification enforcement (already handled
 * per-URL by config.ts's assertHttpsInProduction), response/stream body-size
 * bounds, and per-provider circuit/health metrics — each is a separate #48 AC
 * that touches call sites this slice doesn't.
 */

export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
])

// D1: 429 is included even though it isn't a server error — it's the one status
// where the upstream is explicitly asking for a retry (optionally with a
// Retry-After delay), which is a different signal than "this call is unsafe to
// repeat." 500/501 are deliberately excluded: an ordinary 500 is far more often
// a bad request/bug than a transient condition, and blindly retrying it just
// triples load on an already-erroring upstream.
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504])

const CORRELATION_HEADER = "X-Correlation-Id"
const INBOUND_CORRELATION_HEADERS = ["x-correlation-id", "x-request-id"]

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 200
const DEFAULT_MAX_DELAY_MS = 5_000

export interface RetryOptions {
  /** Total attempts including the first, default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number
  /** Base backoff before jitter, in ms. Default {@link DEFAULT_BASE_DELAY_MS}. */
  baseDelayMs?: number
  /** Upper bound applied to both backoff and a honored Retry-After. Default {@link DEFAULT_MAX_DELAY_MS}. */
  maxDelayMs?: number
}

export interface FetchWithPolicyOptions {
  /** Abort the request after this many ms. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /**
   * Bounded retry/backoff, applied only when the request method is idempotent
   * AND the failure is retryable. Pass `false` to disable retry outright
   * (always appropriate for a mutation whose method happens to be non-standard,
   * e.g. a POST used as a read). Default: enabled with the constants above.
   */
  retry?: RetryOptions | false
  /**
   * Correlation id to propagate as `X-Correlation-Id`, normally read from the
   * inbound request via {@link correlationIdFrom}. Omitted entirely (no header
   * added) when absent — this client never mints one on its own.
   */
  correlationId?: string | null
}

export type HttpClientErrorKind = "timeout" | "network"

/**
 * Typed transport failure. `message` and `cause` are built from the request
 * method/kind and a query-stripped URL only — never from headers — so this is
 * always safe to log or include in a response body without hand-redacting
 * Authorization/Cookie values first.
 */
export class HttpClientError extends Error {
  readonly kind: HttpClientErrorKind
  readonly url: string

  constructor(kind: HttpClientErrorKind, url: string, cause?: unknown) {
    const redacted = redactUrl(url)
    super(
      kind === "timeout"
        ? `Request timed out calling ${redacted}`
        : `Network error calling ${redacted}`
    )
    this.name = "HttpClientError"
    this.kind = kind
    this.url = redacted
    if (cause !== undefined) this.cause = cause
  }
}

/** Strips query string and any userinfo — only origin+pathname ever reaches an error/log line. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split("?")[0]
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Full-jitter backoff (AWS Architecture Blog, "Exponential Backoff and Jitter"):
// uniformly random in [0, min(cap, base * 2^(attempt-1))]. Spreads out retries
// instead of every failed caller retrying in lockstep.
function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.random() * exp
}

// Retry-After per RFC 9110 §10.2.3: either delay-seconds or an HTTP-date. Capped
// by maxDelayMs so a misbehaving/hostile upstream can't park a retry loop for
// an unbounded amount of time.
function retryAfterMs(res: Response, maxDelayMs: number): number | null {
  const header = res.headers.get("retry-after")
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(maxDelayMs, Math.max(0, seconds * 1000))
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) return Math.min(maxDelayMs, Math.max(0, dateMs - Date.now()))
  return null
}

/**
 * Reads a caller-supplied correlation/request id off an inbound Request or
 * Headers, for propagation into an outbound {@link fetchWithPolicy} call.
 * Mirrors operation-context.ts's beginOperation header precedence
 * (x-correlation-id, then x-request-id) so a single inbound id chains the
 * same way through both the event-envelope audit trail and outbound calls.
 */
export function correlationIdFrom(source: Request | Headers | null | undefined): string | undefined {
  if (!source) return undefined
  const headers = source instanceof Headers ? source : source.headers
  for (const name of INBOUND_CORRELATION_HEADERS) {
    const value = headers.get(name)
    if (value && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function buildHeaders(initHeaders: HeadersInit | undefined, correlationId: string | null | undefined): HeadersInit {
  if (!correlationId) return initHeaders ?? {}

  if (initHeaders instanceof Headers) {
    if (initHeaders.has(CORRELATION_HEADER)) return initHeaders
    const merged = new Headers(initHeaders)
    merged.set(CORRELATION_HEADER, correlationId)
    return merged
  }

  if (Array.isArray(initHeaders)) {
    const alreadySet = initHeaders.some(([name]) => name.toLowerCase() === "x-correlation-id")
    return alreadySet ? initHeaders : [...initHeaders, [CORRELATION_HEADER, correlationId]]
  }

  const plain: Record<string, string> = { ...(initHeaders ?? {}) }
  const alreadySet = Object.keys(plain).some((name) => name.toLowerCase() === "x-correlation-id")
  if (!alreadySet) plain[CORRELATION_HEADER] = correlationId
  return plain
}

/**
 * Policy-wrapped `fetch()`: timeout, bounded retry for idempotent+retryable
 * failures, and correlation propagation. Returns the `Response` on any
 * non-retried outcome (including a non-ok status) exactly like a bare `fetch`
 * call would — callers keep deciding what a given status means, this only
 * decides whether to try again first.
 */
export async function fetchWithPolicy(
  url: string,
  init: RequestInit = {},
  options: FetchWithPolicyOptions = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const retryConfig =
    options.retry === false
      ? null
      : {
          maxAttempts: options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
          maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
        }
  const canRetry = retryConfig !== null && IDEMPOTENT_METHODS.has(method)
  const maxAttempts = canRetry ? retryConfig.maxAttempts : 1

  const requestInit: RequestInit = {
    ...init,
    headers: buildHeaders(init.headers, options.correlationId),
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      const response = await fetch(url, { ...requestInit, signal: controller.signal })
      clearTimeout(timer)

      if (canRetry && attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        const waitMs =
          response.status === 429
            ? (retryAfterMs(response, retryConfig.maxDelayMs) ??
              computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs))
            : computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs)
        await delay(waitMs)
        continue
      }
      return response
    } catch (err) {
      clearTimeout(timer)
      // Timeouts are a deliberate signal that the upstream is too slow right
      // now — never retried here (a caller wanting timeout-triggered retry can
      // still catch HttpClientError and decide that itself). Only a genuine
      // network-level failure (DNS, TLS, connection reset, ...) is retried,
      // and only for an idempotent method.
      const kind: HttpClientErrorKind = timedOut ? "timeout" : "network"
      if (canRetry && attempt < maxAttempts && kind === "network") {
        await delay(computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs))
        continue
      }
      throw new HttpClientError(kind, url, err)
    }
  }

  // Unreachable: the loop above always returns or throws before falling off
  // the end (maxAttempts >= 1). Kept only so TS sees every path return/throw.
  throw new HttpClientError("network", url)
}
