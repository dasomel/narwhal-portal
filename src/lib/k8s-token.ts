/**
 * Kubernetes API bearer-token provider (Portal #20).
 *
 * Production reads the token from a projected serviceAccountToken volume file
 * (default path is the well-known in-cluster mount; override via
 * K8S_SA_TOKEN_FILE for a non-standard mount). The file is re-read on a short
 * interval and immediately after invalidateK8sBearerToken(), so a 1h-rotated
 * token takes effect without restarting the process — unlike the K8S_SA_TOKEN
 * env var this replaces, which was read once at module load and never changed
 * for the life of the pod (see k8s-client.ts / live-k8s-informer.ts history).
 *
 * K8S_SA_TOKEN remains a fallback, but ONLY outside production — mirrors
 * getDependencyUrl's fail-fast contract in config.ts: a production pod with no
 * mounted token file throws rather than silently falling back to a long-lived
 * static credential.
 *
 * The `aud` claim is checked ONLY when K8S_TOKEN_AUDIENCE is explicitly set —
 * see the comment on expectedAudience() below for why there's no default.
 */
import { readFileSync } from "fs"
import { isProduction } from "./config"

const DEFAULT_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token"
// How long a successfully-read token is served from cache before the file is
// re-read. Short enough that a 3600s-lifetime projected token is always
// refreshed well ahead of expiry with no restart involved.
const REFRESH_INTERVAL_MS = 60_000

let warnedNoAudienceConfigured = false

interface CachedToken {
  value: string
  readAtMs: number
}

let cached: CachedToken | null = null

function tokenFilePath(): string {
  return process.env.K8S_SA_TOKEN_FILE || DEFAULT_TOKEN_FILE
}

// K8S_TOKEN_AUDIENCE has no default: kubeadm clusters mint the projected
// token's default audience from the API server's --service-account-issuer,
// which is commonly the cluster-internal issuer URL (e.g.
// https://kubernetes.default.svc.cluster.local, see deploy/skaffold-dev-portal.yaml's
// projected volume) rather than the bare https://kubernetes.default.svc some
// docs assume — a hard default here would reject real tokens on real clusters.
// The check only runs when this is explicitly set, and must match whatever
// `audience:` the projected volume declares.
function expectedAudience(): string | null {
  return process.env.K8S_TOKEN_AUDIENCE || null
}

function readTokenFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/** Decodes a JWT payload — no signature verification, only used for the audience check below. */
function decodeJwtPayload(token: string): { aud?: string | string[] } | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { aud?: string | string[] }
  } catch {
    return null
  }
}

/**
 * Rejects a decodable JWT whose `aud` claim doesn't include the expected
 * Kubernetes API audience — but ONLY when K8S_TOKEN_AUDIENCE is explicitly
 * configured. Left unset, any audience is accepted (logged once at debug
 * level) since the cluster's actual default audience varies by issuer
 * configuration and guessing wrong would fail-closed on a healthy token.
 * Opaque (non-JWT) tokens — e.g. a dev-only K8S_SA_TOKEN — can't be decoded
 * and are passed through unchecked either way.
 */
function assertAudience(token: string): void {
  const expected = expectedAudience()
  if (!expected) {
    if (!warnedNoAudienceConfigured) {
      warnedNoAudienceConfigured = true
      console.debug("[k8s-token] K8S_TOKEN_AUDIENCE not set — skipping audience check")
    }
    return
  }
  const payload = decodeJwtPayload(token)
  if (!payload) return
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (auds.length > 0 && !auds.includes(expected)) {
    throw new Error(`K8s service account token audience mismatch: expected "${expected}", got [${auds.join(", ")}]`)
  }
}

/**
 * Forces the next getK8sBearerToken() call to re-read the token file instead
 * of serving the cached value. Call this after a 401 from the API server so a
 * rotated (or freshly re-mounted) token takes effect immediately rather than
 * waiting for REFRESH_INTERVAL_MS.
 */
export function invalidateK8sBearerToken(): void {
  cached = null
}

export function getK8sBearerToken(): string {
  const now = Date.now()
  if (cached && now - cached.readAtMs < REFRESH_INTERVAL_MS) {
    return cached.value
  }

  const fromFile = readTokenFile(tokenFilePath())
  if (fromFile) {
    assertAudience(fromFile)
    cached = { value: fromFile, readAtMs: now }
    return fromFile
  }

  if (!isProduction()) {
    const envToken = process.env.K8S_SA_TOKEN ?? ""
    cached = { value: envToken, readAtMs: now }
    return envToken
  }

  throw new Error(
    `Missing required production configuration: projected service account token not found at ${tokenFilePath()} (K8S_SA_TOKEN env fallback is dev-only)`,
  )
}
