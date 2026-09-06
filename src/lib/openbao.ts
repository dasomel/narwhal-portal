import { readFileSync } from "fs"
import { join } from "path"
import { cacheGet, cacheSet } from "./valkey"
import { getDependencyUrl } from "./config"

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
const OPENBAO_TOKEN = process.env.OPENBAO_TOKEN ?? ""

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

function baoFetch(path: string, init?: RequestInit) {
  const addr = openbaoAddr()
  assertHttpsInProduction(addr)
  return fetch(`${addr}${path}`, {
    ...init,
    headers: { "X-Vault-Token": OPENBAO_TOKEN, ...init?.headers },
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
