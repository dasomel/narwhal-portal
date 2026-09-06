import { readFileSync } from "fs"
import { join } from "path"
import { cacheGet, cacheSet } from "./valkey"
import { getDependencyUrl, isProduction } from "./config"

const VAULT_SECRETS_PATH = "/vault/secrets"

/**
 * OpenBao Agent Injector가 마운트한 시크릿 파일 읽기. 파일이 없으면 환경변수 폴백.
 */
export function getSecret(name: string, envFallback?: string): string {
  const filePath = join(VAULT_SECRETS_PATH, name)
  try {
    return readFileSync(filePath, "utf-8").trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  const envVal = envFallback ? process.env[envFallback] : undefined
  if (envVal) return envVal
  throw new Error(`Secret '${name}' not found in OpenBao or environment`)
}

// --- HTTP 클라이언트 ---

function openbaoAddr(): string {
  return getDependencyUrl("OPENBAO_ADDR", "http://localhost:8200")
}

export interface SecretEntry {
  path: string
  version: number
  createdTime: string
  updatedTime: string
}

/**
 * Thrown when OpenBao secret metadata cannot be read (non-404 error on the list
 * or a per-secret metadata call). listSecrets() fails closed on this instead of
 * returning an empty/partial list — an empty array would read as "no secrets
 * exist" to the governance view (portal#19) when the real cause is a permission
 * or connectivity problem, silently under-reporting exposure rather than
 * surfacing the degraded state explicitly.
 */
export class SecretMetadataError extends Error {}

let httpsChecked = false
function assertHttpsInProduction(addr: string): void {
  if (httpsChecked) return
  httpsChecked = true
  if (!addr.startsWith("http://")) return
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `[OpenBao] OPENBAO_ADDR must use HTTPS in production. Got: ${addr}`
    )
  }
  console.warn(
    `[OpenBao] OPENBAO_ADDR is using HTTP (${addr}) — HTTPS required in production`
  )
}

// --- Kubernetes auth token provider (narwhal#156 / portal#54) ---
//
// The cluster stopped injecting a long-lived OPENBAO_TOKEN and instead grants
// this workload OpenBao Kubernetes auth (auth/kubernetes/login) via a projected
// service-account token. OPENBAO_K8S_AUTH_AUDIENCE ("vault") is consumed by the
// kubelet when minting that projected token (kustomize/helm on the cluster
// side) — the login call itself only needs the resulting JWT, not the audience.

const DEFAULT_K8S_ROLE = "narwhal-portal"
const DEFAULT_K8S_AUTH_MOUNT = "kubernetes"
const DEFAULT_K8S_TOKEN_PATH = "/var/run/secrets/openbao/token"
const FALLBACK_K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"

function k8sAuthMount(): string {
  return process.env.OPENBAO_K8S_AUTH_MOUNT || DEFAULT_K8S_AUTH_MOUNT
}

function k8sRole(): string {
  return process.env.OPENBAO_K8S_ROLE || DEFAULT_K8S_ROLE
}

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    return null
  }
}

// Reads the projected SA token, falling back to the default in-cluster SA
// token when the OpenBao-specific projected volume isn't mounted.
function readK8sJwt(): string | null {
  const primary = process.env.OPENBAO_K8S_TOKEN_PATH || DEFAULT_K8S_TOKEN_PATH
  return readFileIfExists(primary) ?? readFileIfExists(FALLBACK_K8S_TOKEN_PATH)
}

function resolvedAuthMethod(): "kubernetes" | "token" {
  const configured = process.env.OPENBAO_AUTH_METHOD
  if (configured === "token" || configured === "kubernetes") return configured
  // Unset: prefer Kubernetes auth when a projected SA token is actually mounted.
  return readK8sJwt() !== null ? "kubernetes" : "token"
}

// OPENBAO_TOKEN is only a legitimate source of truth when auth is explicitly
// (or implicitly, outside production) static-token mode. Mirrors
// getDependencyUrl()'s fail-fast pattern: throw in production, tolerate an
// empty token in dev so local flows without OpenBao configured still boot.
function tokenFromEnv(): string {
  const envToken = process.env.OPENBAO_TOKEN
  if (envToken) return envToken
  if (isProduction()) {
    throw new Error(
      "[OpenBao] Missing required production configuration: no Kubernetes auth JWT found and OPENBAO_TOKEN is not set"
    )
  }
  return ""
}

interface CachedToken {
  token: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null

async function loginWithKubernetes(): Promise<CachedToken> {
  const jwt = readK8sJwt()
  if (!jwt) {
    throw new Error(
      "[OpenBao] Kubernetes auth JWT not found at OPENBAO_K8S_TOKEN_PATH or the default service-account token path"
    )
  }

  const addr = openbaoAddr()
  assertHttpsInProduction(addr)
  const mount = k8sAuthMount()

  const res = await fetch(`${addr}/v1/auth/${mount}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: k8sRole(), jwt }),
  })
  if (!res.ok) {
    throw new Error(`[OpenBao] Kubernetes auth login failed: ${res.status}`)
  }

  const data = await res.json()
  const clientToken: string | undefined = data?.auth?.client_token
  const leaseDuration: number = data?.auth?.lease_duration ?? 3600
  if (!clientToken) {
    throw new Error("[OpenBao] Kubernetes auth login response missing auth.client_token")
  }

  // Refresh at 80% of the lease so we re-login before the 1h client token
  // actually expires, even under clock drift.
  return { token: clientToken, expiresAt: Date.now() + leaseDuration * 0.8 * 1000 }
}

/**
 * Resolves the token to send as X-Vault-Token. Kubernetes-auth tokens are
 * cached in-memory (per process) until ~80% of their lease elapses; pass
 * `forceRefresh` to bypass the cache and re-login (used after a 403).
 */
export async function getOpenBaoToken(forceRefresh = false): Promise<string> {
  if (resolvedAuthMethod() === "token") {
    return tokenFromEnv()
  }

  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token
  }

  cachedToken = await loginWithKubernetes()
  return cachedToken.token
}

async function baoFetch(path: string, init?: RequestInit): Promise<Response> {
  const addr = openbaoAddr()
  assertHttpsInProduction(addr)

  const token = await getOpenBaoToken()
  const res = await fetch(`${addr}${path}`, {
    ...init,
    headers: { "X-Vault-Token": token, ...init?.headers },
  })

  if (res.status !== 403) return res

  // Client token may have been revoked/expired server-side before our cache
  // window elapsed (or a static OPENBAO_TOKEN was rotated) — re-login once.
  const retryToken = await getOpenBaoToken(true)
  return fetch(`${addr}${path}`, {
    ...init,
    headers: { "X-Vault-Token": retryToken, ...init?.headers },
  })
}

export async function listSecrets(): Promise<SecretEntry[]> {
  const cacheKey = "openbao:secrets"
  const cached = await cacheGet<SecretEntry[]>(cacheKey)
  if (cached) return cached

  // The scoped policy only grants list/read on secret/metadata/narwhal-portal/*,
  // so list the granted sub-prefix rather than the KV mount root (which 403s).
  const SECRET_PREFIX = "narwhal-portal/"

  const listRes = await baoFetch(`/v1/secret/metadata/${SECRET_PREFIX}?list=true`)
  if (listRes.status === 404) {
    // KV v2 404s a list on a prefix with nothing under it — a genuine empty
    // inventory, distinct from a read failure, so this caches and returns clean.
    await cacheSet(cacheKey, [], 30)
    return []
  }
  if (!listRes.ok) {
    throw new SecretMetadataError(`Failed to list secret metadata (HTTP ${listRes.status})`)
  }

  const listData = await listRes.json()
  // Keys are returned relative to the listed prefix (e.g. "keycloak-token"),
  // so prefix them back for metadata lookups while displaying the leaf name.
  const keys: string[] = listData?.data?.keys ?? []

  // portal#19: this used to also GET /v1/secret/data/<path> per secret solely to
  // read Object.keys() off the value, which required KV data-read capability the
  // inventory view has no business holding. Everything the UI shows now comes
  // from /v1/secret/metadata/<path> alone; KV v2 metadata does not expose field
  // names, so per-secret key names are dropped rather than approximated.
  const entries: SecretEntry[] = await Promise.all(
    keys.filter((k) => !k.endsWith("/")).map(async (key) => {
      const fullPath = `${SECRET_PREFIX}${key}`
      const metaRes = await baoFetch(`/v1/secret/metadata/${fullPath}`)
      if (!metaRes.ok) {
        throw new SecretMetadataError(`Failed to read metadata for '${key}' (HTTP ${metaRes.status})`)
      }
      const meta = await metaRes.json()
      return {
        path: key,
        version: meta?.data?.current_version ?? 0,
        createdTime: meta?.data?.created_time ?? "",
        updatedTime: meta?.data?.updated_time ?? "",
      }
    })
  )

  await cacheSet(cacheKey, entries, 30)
  return entries
}
