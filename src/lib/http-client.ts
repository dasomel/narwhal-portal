/**
 * Shared outbound HTTP client (portal#48): the transport-policy primitive every
 * OSS provider adapter (ArgoCD, Gitea, Prometheus, Keycloak, ...) should call
 * instead of `fetch()` directly, so timeout/retry/correlation/error-redaction
 * behavior is one policy instead of N ad-hoc `AbortController` + `setTimeout`
 * copies scattered across src/lib.
 *
 * Scope of this slice (see #48's AC list for the full roadmap):
 *  - per-call timeout via AbortSignal, combined with an optional caller signal
 *    so cancelling the caller's own request (e.g. the inbound Next.js request
 *    aborting) still cancels the outbound one
 *  - bounded retry+backoff, gated on BOTH an idempotent method AND a retryable
 *    failure (network error, 502/503/504, 429 honoring Retry-After), draining
 *    a retried response's body first so the connection is actually released
 *  - a deadline that survives past the headers: readJsonWithPolicy/
 *    readTextWithPolicy bound the BODY read to whatever time is left of the
 *    original timeoutMs, instead of the timer clearing the moment headers
 *    arrive and leaving a stalled body free to hang forever
 *  - correlation/request-id propagation from an inbound Request/Headers when
 *    the caller has one
 *  - a typed error whose message/cause never includes header values or
 *    userinfo, so a caller can log it directly without redacting
 *    Authorization/Cookie by hand
 *
 * Left open, not attempted here: TLS-verification enforcement (already handled
 * per-URL by config.ts's assertHttpsInProduction), response/stream body-SIZE
 * bounds (this slice bounds body-read TIME, not bytes), and per-provider
 * circuit/health metrics — each is a separate #48 AC that touches call sites
 * this slice doesn't.
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
  /** Abort the request after this many ms (covers connect+headers; see readJsonWithPolicy/readTextWithPolicy for the body). Default {@link DEFAULT_TIMEOUT_MS}. */
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
  /**
   * A caller-owned signal (e.g. the inbound Next.js Request's own AbortSignal)
   * to honor alongside this call's own timeout. Aborting it fails the call
   * immediately with `kind: "aborted"` and is never retried, regardless of
   * method — the caller asked to stop, not "stop unless it's safe to try again."
   */
  signal?: AbortSignal
}

export type HttpClientErrorKind = "timeout" | "network" | "aborted"

/**
 * Typed transport failure. `message` and `url` are built from the request
 * kind and a query/userinfo-stripped URL only — never from headers — so this
 * is always safe to log or include in a response body without hand-redacting
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
        : kind === "aborted"
          ? `Request aborted by caller calling ${redacted}`
          : `Network error calling ${redacted}`
    )
    this.name = "HttpClientError"
    this.kind = kind
    this.url = redacted
    if (cause !== undefined) this.cause = cause
  }
}

// Matches "scheme://user:pass@" so the fallback below can strip it the same
// way u.origin does for a URL the WHATWG parser accepts.
const USERINFO_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/

/** Strips query string and any userinfo — only origin+pathname ever reaches an error/log line. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    // new URL() can reject a string that still embeds real credentials (a
    // missing host, an unescaped space, ...) — a redaction path that only
    // works on well-formed URLs isn't a redaction guarantee, so strip
    // "scheme://user:pass@" by regex here too.
    return url.split("?")[0].replace(USERINFO_RE, "$1")
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

interface CombinedSignal {
  signal: AbortSignal
  /** Removes any listeners this combination added. Always call in a `finally`. */
  cleanup: () => void
}

// Combines the per-attempt timeout controller with an optional caller signal.
// AbortSignal.any (Node >=20.3; this repo's runtime image pins node:22) covers
// the common case with no manual bookkeeping; a listener-based fallback covers
// any environment where it's missing, with its own listeners removed on
// cleanup so nothing outlives the attempt that created it.
function combineSignals(signals: Array<AbortSignal | undefined>): CombinedSignal {
  const active = signals.filter((s): s is AbortSignal => s !== undefined)
  if (active.length <= 1) {
    return { signal: active[0] ?? new AbortController().signal, cleanup: () => {} }
  }
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(active), cleanup: () => {} }
  }

  const controller = new AbortController()
  const onAbort = (source: AbortSignal) => controller.abort(source.reason)
  const bound = active.map((source) => {
    const handler = () => onAbort(source)
    source.addEventListener("abort", handler, { once: true })
    return { source, handler }
  })
  return {
    signal: controller.signal,
    cleanup: () => bound.forEach(({ source, handler }) => source.removeEventListener("abort", handler)),
  }
}

// Best-effort connection release: cancelling an unread body tells the
// underlying connection it can be reused/closed instead of waiting for the
// caller to ever read (or garbage-collect) it. Errors are swallowed — this
// runs on a body we're about to discard either way (a retried response) or a
// body a deadline just cut off, so failing to cancel cleanly is not itself an
// error worth surfacing.
async function cancelBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return
  try {
    await response.body.cancel()
  } catch {
    /* best-effort */
  }
}

// Absolute deadline (ms epoch) for reading each policy response's body,
// keyed by the Response identity fetchWithPolicy returned. A response this
// client didn't produce (e.g. one built by hand in a test) simply has no
// entry, and readJsonWithPolicy/readTextWithPolicy fall back to reading with
// no bound in that case.
const bodyDeadlines = new WeakMap<Response, { deadlineAt: number; url: string }>()

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

// Reads the body ourselves via a reader we hold, instead of calling
// response.json()/.text() and racing that against a timeout: once .json()/
// .text() has locked the stream, response.body.cancel() throws ("stream is
// locked") because it isn't the lock holder — only the reader that holds the
// lock can cancel a stream mid-read. Acquiring the reader here means a
// stalled body can actually be cancelled when the deadline hits, not just
// abandoned to keep the connection open.
async function collectBytesWithDeadline(response: Response, remainingMs: number, url: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  // Cancelling a reader resolves any of ITS OWN pending read() with a normal
  // {done: true} — that's how a locked stream lets its lock holder cancel
  // mid-read at all. Racing read() against the deadline promise is therefore
  // not enough on its own: read() can "win" with a done result that isn't a
  // real end-of-stream, it's the cancellation completing. This flag is
  // checked after every race so that case is still reported as a timeout.
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reader
        .cancel()
        .catch(() => {
          /* best-effort */
        })
        .finally(() => reject(new HttpClientError("timeout", url)))
    }, remainingMs)
  })

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (timedOut) throw new HttpClientError("timeout", url)
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    clearTimeout(timer)
    // Release on every exit path so the stream isn't left locked; releaseLock
    // throws only if a read is still pending, which cancel() has already settled.
    try {
      reader.releaseLock()
    } catch {
      /* already released or pending read */
    }
  }
  return concatBytes(chunks)
}

async function readBodyWithDeadline<T>(response: Response, parse: (text: string) => T): Promise<T> {
  const entry = bodyDeadlines.get(response)
  if (!entry) return parse(await response.text())

  const remainingMs = entry.deadlineAt - Date.now()
  if (remainingMs <= 0) {
    await cancelBody(response)
    throw new HttpClientError("timeout", entry.url)
  }

  const bytes = await collectBytesWithDeadline(response, remainingMs, entry.url)
  return parse(new TextDecoder().decode(bytes))
}

/**
 * Parses a {@link fetchWithPolicy} response as JSON, bounded by whatever time
 * remains of that call's original `timeoutMs` — a stalled/slow body cannot
 * hang past the same deadline the headers were already subject to. Falls back
 * to a plain, unbounded `response.text()` + JSON.parse for a Response this
 * client didn't produce.
 */
export function readJsonWithPolicy<T = unknown>(response: Response): Promise<T> {
  return readBodyWithDeadline(response, (text) => JSON.parse(text) as T)
}

/** Text-body counterpart of {@link readJsonWithPolicy}, same deadline semantics. */
export function readTextWithPolicy(response: Response): Promise<string> {
  return readBodyWithDeadline(response, (text) => text)
}

/**
 * Policy-wrapped `fetch()`: timeout (combined with an optional caller signal),
 * bounded retry for idempotent+retryable failures, and correlation
 * propagation. Returns the `Response` on any non-retried outcome (including a
 * non-ok status) exactly like a bare `fetch` call would — callers keep
 * deciding what a given status means, this only decides whether to try again
 * first. Read the body via {@link readJsonWithPolicy}/{@link readTextWithPolicy}
 * (not `response.json()`/`.text()` directly) to keep the original deadline in
 * force for a slow body too.
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
    const attemptStartedAt = Date.now()
    const timeoutController = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      timeoutController.abort()
    }, timeoutMs)
    const { signal, cleanup } = combineSignals([timeoutController.signal, options.signal])

    try {
      const response = await fetch(url, { ...requestInit, signal })

      if (canRetry && attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
        // Draining the body before the next attempt releases the connection
        // instead of leaking it — nothing downstream will ever read a
        // response we're about to discard for a retry.
        await cancelBody(response)
        const waitMs =
          response.status === 429
            ? (retryAfterMs(response, retryConfig.maxDelayMs) ??
              computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs))
            : computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs)
        await delay(waitMs)
        continue
      }

      // The timer above only covers connect-through-headers; record the
      // deadline that still applies to reading THIS response's body so
      // readJsonWithPolicy/readTextWithPolicy can bound it later, instead of
      // a stalled body being free to hang forever once this function returns.
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - attemptStartedAt))
      bodyDeadlines.set(response, { deadlineAt: Date.now() + remainingMs, url })
      return response
    } catch (err) {
      // Caller abort takes priority in classification: if the caller's own
      // signal is what fired, that's true regardless of whether our timeout
      // also happened to elapse around the same time, and it is never
      // retried — the caller asked to stop, full stop.
      const kind: HttpClientErrorKind = options.signal?.aborted ? "aborted" : timedOut ? "timeout" : "network"
      if (canRetry && attempt < maxAttempts && kind === "network") {
        await delay(computeBackoffMs(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs))
        continue
      }
      throw new HttpClientError(kind, url, err)
    } finally {
      clearTimeout(timer)
      cleanup()
    }
  }

  // Unreachable: the loop above always returns or throws before falling off
  // the end (maxAttempts >= 1). Kept only so TS sees every path return/throw.
  throw new HttpClientError("network", url)
}
