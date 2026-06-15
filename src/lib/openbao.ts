import { readFileSync } from "fs"
import { join } from "path"
import { cacheGet, cacheSet } from "./valkey"

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

const OPENBAO_ADDR = process.env.OPENBAO_ADDR ?? "http://localhost:8200"
const OPENBAO_TOKEN = process.env.OPENBAO_TOKEN ?? ""

export interface SecretEntry {
  path: string
  keys: string[]
  version: number
  createdTime: string
}

let httpsChecked = false
function assertHttpsInProduction(): void {
  if (httpsChecked) return
  httpsChecked = true
  if (!OPENBAO_ADDR.startsWith("http://")) return
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `[OpenBao] OPENBAO_ADDR must use HTTPS in production. Got: ${OPENBAO_ADDR}`
    )
  }
  console.warn(
    `[OpenBao] OPENBAO_ADDR is using HTTP (${OPENBAO_ADDR}) — HTTPS required in production`
  )
}

function baoFetch(path: string, init?: RequestInit) {
  assertHttpsInProduction()
  return fetch(`${OPENBAO_ADDR}${path}`, {
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
  if (!listRes.ok) return []

  const listData = await listRes.json()
  // Keys are returned relative to the listed prefix (e.g. "keycloak-token"),
  // so prefix them back for metadata/data lookups while displaying the leaf name.
  const keys: string[] = listData?.data?.keys ?? []

  const entries: SecretEntry[] = await Promise.all(
    keys.filter((k) => !k.endsWith("/")).map(async (key) => {
      const fullPath = `${SECRET_PREFIX}${key}`
      try {
        const metaRes = await baoFetch(`/v1/secret/metadata/${fullPath}`)
        if (!metaRes.ok) return { path: key, keys: [], version: 0, createdTime: "" }
        const meta = await metaRes.json()
        const version = meta?.data?.current_version ?? 0
        const createdTime = meta?.data?.created_time ?? ""
        const dataRes = await baoFetch(`/v1/secret/data/${fullPath}`)
        const secretData = dataRes.ok ? await dataRes.json() : null
        const secretKeys = secretData?.data?.data ? Object.keys(secretData.data.data) : []
        return { path: key, keys: secretKeys, version, createdTime }
      } catch {
        return { path: key, keys: [], version: 0, createdTime: "" }
      }
    })
  )

  await cacheSet(cacheKey, entries, 30)
  return entries
}
