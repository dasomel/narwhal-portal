---
name: idp-backend
description: "Backend API development guide for Narwhal IDP Portal. Covers Next.js 16 API Routes integrating Authentik, ArgoCD, APISIX, Prometheus, Alertmanager, OpenBao, and Valkey. Use this skill when adding API routes, developing infrastructure client libraries, or implementing cache strategies. Triggers on 'API', 'route', 'cache', 'infrastructure integration'."
---

# IDP Portal Backend Development

Backend API development patterns and infrastructure service integration guide for the Narwhal IDP Portal.

## Mandatory Rules
- Next.js 16 API Route patterns may differ from training data. Always read guides in `node_modules/next/dist/docs/` before writing code.

## Adding an API Route

```tsx
// src/app/api/{domain}/route.ts
import { NextResponse } from "next/server"

export async function GET() {
  try {
    const data = await fetchFromService()
    return NextResponse.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

Important: Define API response shapes as interfaces to establish a clear contract with the frontend.

## Infrastructure Client Pattern

All clients follow the same pattern:

```tsx
// src/lib/{service}.ts
import { cacheGet, cacheSet } from "./valkey"

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:PORT"
const TOKEN = process.env.SERVICE_TOKEN ?? ""

function headers() {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
}

export async function getData(): Promise<DataType[]> {
  const cached = await cacheGet<DataType[]>("service:data")
  if (cached) return cached

  const res = await fetch(`${SERVICE_URL}/api/endpoint`, { headers: headers() })
  if (!res.ok) throw new Error(`Service API ${res.status}`)
  const data = await res.json()

  await cacheSet("service:data", data.results, 30) // TTL in seconds
  return data.results
}
```

Core principles:
1. Environment variables with localhost fallback defaults
2. Check Valkey cache first → on miss, call external API → store in cache
3. Throw with meaningful messages on errors
4. Cache failure is non-fatal (try/catch handled in valkey.ts)

## Service Authentication

| Service | Auth Method | Environment Variable |
|---------|-----------|---------------------|
| Authentik | `Authorization: Bearer {token}` | `AUTHENTIK_ADMIN_TOKEN` |
| ArgoCD | `Authorization: Bearer {token}` | `ARGOCD_TOKEN` |
| APISIX | `X-API-KEY: {key}` | `APISIX_API_KEY` |
| Prometheus | None | - |
| Alertmanager | None | - |

## Cache Key Naming Convention

Format: `{service}:{resource}` — e.g. `authentik:users`, `argocd:apps`, `apisix:routes`, `prom:{query}`, `alerts:active`

TTL guide:
- Metrics/alerts (real-time critical): 10-15s
- Users/groups (low change frequency): 30-60s
- Routes/config (low change frequency): 30s

## Secret Management

OpenBao Agent Injector mounts secrets as files at `/vault/secrets/`. Use those first, fall back to env vars for local development.

```tsx
import { getSecret } from "./openbao"
const token = getSecret("authentik-token", "AUTHENTIK_ADMIN_TOKEN")
```

## Infrastructure Service Map

| Service | Client | Auth | Cache TTL |
|---------|--------|------|-----------|
| Authentik | `authentik-client.ts` | Bearer token | 30-60s |
| ArgoCD | `argocd.ts` | Bearer token | 10s |
| APISIX | `apisix-client.ts` | X-API-KEY | 30s |
| Prometheus | `prometheus.ts` | None | 15s |
| Alertmanager | `alertmanager.ts` | None | 15s |
| Valkey | `valkey.ts` | None | - |
| OpenBao | `openbao.ts` | File-based | - |

## Error Response Rules

| Scenario | Status Code | Response |
|----------|-----------|---------|
| Success | 200 | `{ data }` |
| Invalid input | 400 | `{ error: "description" }` |
| Auth required | 401 | `{ error: "Unauthorized" }` |
| Insufficient perms | 403 | `{ error: "Forbidden" }` |
| External service failure | 502 | `{ error: "Service response failed" }` |
| Internal error | 500 | `{ error: "Internal Server Error" }` |
