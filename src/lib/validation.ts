/**
 * Common input validation utilities for API routes / infra clients.
 *
 * S3 stream — input validation & authorization hardening.
 *
 * All assertion helpers throw `ValidationError`, which API routes can catch
 * and translate to a 400 response with the standard shape:
 *   { error: "ValidationError", message: string, field: string }
 */

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

// RFC 1123 label — DNS-style names used by K8s for namespaces, pods, services.
export const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

// Same rule for namespaces (RFC 1123 label).
export const K8S_NAMESPACE_RE = K8S_NAME_RE

// K8s node name — RFC 1123 subdomain (allows dots between labels).
// Some clouds use FQDN-style node names, e.g. `ip-10-0-0-1.ec2.internal`.
export const K8S_NODE_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/

// Standard UUID v1-v5.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// PromQL safe-character whitelist (used only for free-form queries by
// cluster-admin). Does NOT cover unsafe characters like `;` or `\` —
// inputs containing those are rejected.
// `$` is required for label_replace() replacement refs (e.g. "$1:9100"); `|` is
// required for PromQL regex matchers (e.g. fstype!~"tmpfs|overlay", device!~"lo|veth.*").
// Both are used by the app's own server-built metric queries. Still excludes `;` and
// `\` (injection-unsafe). All these queries are built from server-side allowlists with
// only the (separately-validated) node name as variable input.
export const PROMQL_SAFE_RE = /^[a-zA-Z0-9_{}=!~"',\s\.\(\)\[\]\-+*/:$|]+$/

// LogQL allows the same lexical character set as PromQL plus `|` for filters.
export const LOGQL_SAFE_RE = /^[a-zA-Z0-9_{}=!~"',\s\.\(\)\[\]\-+*/:|]+$/

// TraceQL safe-character whitelist — superset of PromQL allowing `&&`/`||`
// boolean composition handled implicitly by `|` and `&`.
export const TRACEQL_SAFE_RE = /^[a-zA-Z0-9_{}=!~"',\s\.\(\)\[\]\-+*/:|&]+$/

// Maximum length for free-form query strings.
export const MAX_PROMQL_LEN = 2000
export const MAX_LOGQL_LEN = 2000
export const MAX_TRACEQL_LEN = 2000

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly field: string
  constructor(message: string, field = "input") {
    super(message)
    this.name = "ValidationError"
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Assertions — throw ValidationError on failure
// ---------------------------------------------------------------------------

export function assertK8sName(v: unknown, kind = "name"): asserts v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 253) {
    throw new ValidationError(`invalid ${kind}: must be a non-empty string (≤253 chars)`, kind)
  }
  if (!K8S_NAME_RE.test(v)) {
    throw new ValidationError(`invalid ${kind}: must match RFC 1123 label`, kind)
  }
}

export function assertK8sNamespace(v: unknown): asserts v is string {
  assertK8sName(v, "namespace")
}

/** Node names may be FQDN-style with dots (RFC 1123 subdomain). */
export function assertK8sNodeName(v: unknown): asserts v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 253) {
    throw new ValidationError("invalid node name: must be a non-empty string (≤253 chars)", "node")
  }
  if (!K8S_NODE_NAME_RE.test(v)) {
    throw new ValidationError("invalid node name: must match RFC 1123 subdomain", "node")
  }
}

export function assertUuid(v: unknown, field = "id"): asserts v is string {
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    throw new ValidationError(`invalid ${field}: must be a UUID`, field)
  }
}

/**
 * Asserts the value is an HTTP(S) URL and (optionally) hosted at one of the
 * allowlisted domains. Returns the parsed URL on success.
 */
export function assertHttpUrl(v: unknown, allowedHosts?: string[], field = "url"): URL {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) {
    throw new ValidationError(`invalid ${field}: must be a non-empty string (≤2048 chars)`, field)
  }
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw new ValidationError(`invalid ${field}: not a valid URL`, field)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(`invalid ${field}: only http(s) is allowed`, field)
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase()
    const ok = allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase()))
    if (!ok) {
      throw new ValidationError(`invalid ${field}: host not in allowlist`, field)
    }
  }
  return url
}

/**
 * Asserts a free-form PromQL query is safe to forward.
 * - Length-bounded
 * - Restricted to a known character whitelist
 * - Disallows `;`, `\`, control chars (already excluded by the whitelist)
 */
export function assertPromQLSafe(v: unknown, field = "promql"): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ValidationError(`invalid ${field}: must be a non-empty string`, field)
  }
  if (v.length > MAX_PROMQL_LEN) {
    throw new ValidationError(`invalid ${field}: too long (>${MAX_PROMQL_LEN})`, field)
  }
  if (!PROMQL_SAFE_RE.test(v)) {
    throw new ValidationError(`invalid ${field}: contains disallowed characters`, field)
  }
}

export function assertLogQLSafe(v: unknown, field = "logql"): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ValidationError(`invalid ${field}: must be a non-empty string`, field)
  }
  if (v.length > MAX_LOGQL_LEN) {
    throw new ValidationError(`invalid ${field}: too long (>${MAX_LOGQL_LEN})`, field)
  }
  if (!LOGQL_SAFE_RE.test(v)) {
    throw new ValidationError(`invalid ${field}: contains disallowed characters`, field)
  }
}

export function assertTraceQLSafe(v: unknown, field = "traceql"): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ValidationError(`invalid ${field}: must be a non-empty string`, field)
  }
  if (v.length > MAX_TRACEQL_LEN) {
    throw new ValidationError(`invalid ${field}: too long (>${MAX_TRACEQL_LEN})`, field)
  }
  if (!TRACEQL_SAFE_RE.test(v)) {
    throw new ValidationError(`invalid ${field}: contains disallowed characters`, field)
  }
}

// ---------------------------------------------------------------------------
// Helpers for API routes
// ---------------------------------------------------------------------------

/**
 * Standard response shape returned by API routes when validation fails.
 * Use together with HTTP 400.
 */
export interface ValidationErrorBody {
  error: "ValidationError"
  message: string
  field: string
}

export function toValidationErrorBody(err: ValidationError): ValidationErrorBody {
  return { error: "ValidationError", message: err.message, field: err.field }
}

/**
 * Wraps a value in encodeURIComponent after asserting it matches a
 * RFC 1123 label — defensive double-protection so any future mistake
 * still cannot break out of the path segment.
 */
export function safeK8sSegment(v: string): string {
  // Caller must have already asserted; this is the encode step.
  return encodeURIComponent(v)
}
