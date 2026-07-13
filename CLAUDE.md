# Narwhal IDP Portal — Claude Code Guide

> Kubernetes Internal Developer Platform Portal — Next.js 16 + React 19

## Quick Overview

Management portal for the Narwhal Kubernetes cluster IDP. Provides dashboard (metrics, ArgoCD, alerts), settings (users/routes/certificates/policies), onboarding (kubeconfig, guide), and platform tools grid.

> **Working procedure:** follow the global `<procedural_completion>` doctrine (`~/.claude/CLAUDE.md`) on substantive tasks — goal → decompose → execute → verify → risk (five principles + completion gate + escalation). Trivial one-shots answer directly.

---

## Companion Cluster Repository

This portal is the **frontend/management UI for the Narwhal cluster**. Both repos live under
the same IDP workspace; the cluster source is the sibling directory:

```
/Users/m/Documents/IdeaProjects/20.dasomel/idp/narwhal
```

| Path (under `narwhal/`) | Purpose |
|------|---------|
| `gitops/charts/narwhal-apps/templates/` | ArgoCD Applications — source of truth for deployed cluster apps (rendered by the app-of-apps Helm chart) |
| `gitops/charts/narwhal-platform/templates/` | Platform manifests incl. the portal's K8s resources (`narwhal-portal-k8s.yaml`) and APISIX routes |
| `gitops/apps/` | `app-of-apps.yaml` only (points ArgoCD at `charts/narwhal-apps`) |
| `configs/gitops/` | GitOps configuration values |
| `scripts/cluster/` | Cluster install/operation scripts — incl. `11-3-keycloak-clients.sh` (OIDC clients), `13-2-narwhal-portal-bindings.sh` (portal RBAC + API token), `15-narwhal-portal.sh` (portal deploy) |
| `csp/` | CSP/cloud provider integration |
| `docs/` | Cluster architecture and operational docs |
| `CLAUDE.md`, `README.md`, `VERSIONS.md`, `CHANGELOG.md` | Authoritative cluster references |

### When to consult the cluster repo
- Adding/modifying portal integrations with cluster services (Keycloak, ArgoCD, APISIX, OpenBao, Prometheus, Alertmanager, Falco) — verify endpoints, namespaces, secret paths, and service names against `gitops/charts/narwhal-apps/templates/` and `gitops/charts/narwhal-platform/templates/`.
- Implementing onboarding/auth flows (kubeconfig, OIDC) — match against `scripts/cluster/11-*-keycloak*.sh`.
- RBAC role definitions — cross-check `gitops/resources/` ClusterRole/RoleBinding sources and `scripts/cluster/13-2-narwhal-portal-bindings.sh`.
- Resolving any "what's the real URL/port/secret name?" question — cluster repo wins over assumptions.

> Treat the cluster repo as **read-only reference**. Do not modify it from this project; route any cluster changes back to that repository.

### Cross-repo seam harness
When a change spans BOTH repos (a portal integration depends on a cluster contract, or you
need to verify the two are aligned), use the **`idp-cross-orchestrator`** harness at the
workspace root (`idp/.claude/`). It extracts what the cluster provides vs what this portal
assumes (endpoints, secret paths, OIDC, RBAC, PromQL, env), reports drift + security findings,
and routes fixes back to the owning harness. Single-repo portal work stays with `portal-*`.

---

## Agent Team Harness

3 specialist agents + 3 domain skills. Agents handle behavior, skills provide domain knowledge.

### Agents (`.claude/agents/`)

| Agent | subagent_type | model | Role |
|-------|--------------|-------|------|
| `portal-frontend` | `portal-frontend` | sonnet | UI development (pages, components, widgets) |
| `portal-backend` | `portal-backend` | sonnet | API development (routes, infra clients, cache) |
| `portal-qa` | `portal-qa` | sonnet | Integration coherence verification |

### Skills (`.claude/skills/`)

| Skill | Description |
|-------|-------------|
| `idp-frontend` | Frontend patterns, project structure, data fetching, RBAC, shadcn/ui, i18n |
| `idp-backend` | API patterns, infra client integration, cache strategy, secret management |
| `idp-qa` | QA procedures, API-frontend shape mapping, boundary verification checklist |

### Orchestration Workflow (main context executes directly)

```
User request → Analyze requirements + write API response shape spec
    ↓
portal-frontend + portal-backend (parallel, run_in_background: true)
    ↓
portal-qa (sequential, after both complete)
    ├── 0 failures → report results
    └── failures   → re-run relevant agent with fix instructions (max 2 loops)
```

- Pass the **same API response shape spec** to both frontend/backend agents
- If only one side changes, run only that agent
- QA report goes to `_workspace/qa_report.md`

---

## Critical Rules

### Next.js 16 Mandatory
- **Always read** `node_modules/next/dist/docs/` guides before writing code. APIs may differ from training data.
- Follow deprecation warnings.

### Server/Client Component Boundary
- **Default is Server Component**. Only declare `"use client"` when client features like `useState`, `useEffect`, or `onClick` are needed.

### API Response Shape Contract
- Always define response shapes as interfaces when creating API routes.
- Frontend consumes these shapes directly. QA cross-verifies.

### Cache First
- All external API calls go through Valkey cache (`cacheGet` → miss → fetch → `cacheSet`).
- Cache failure is non-fatal (falls back to direct API call).
- Cache key naming: `{service}:{resource}` (e.g., `keycloak:users`, `argocd:apps`)

### Role-Based Access Control
- 4 roles: `cluster-admin`, `developer`, `viewer`, `guest`
- `nav.tsx` `menuItems[].roles` and `tools.ts` `PLATFORM_TOOLS[].roles` must stay consistent.

### i18n (Korean/English)
- All UI text must use the i18n system — no hardcoded Korean or English strings in components.
- Shared translations: `src/lib/i18n.ts` (dictionaries + `t()` function + types)
- Server components: `import { getLocale } from "@/lib/i18n-server"` then `t(locale, "key")`
- Client components: `import { useT } from "@/lib/i18n-client"` then `const t = useT(); t("key")`
- Locale stored in cookie (`locale`), default `ko`. Switcher in nav bar.
- When adding new UI text, add keys to both `ko` and `en` dictionaries in `i18n.ts`.

### UI Convention
- Prefer shadcn/ui components. If missing, run `npx shadcn@latest add {component}`.
- Use TailwindCSS utility classes only, no inline styles.

### Commit Policy
- **Commit after each task** (once complete + verified), scoped to the files it touched, Conventional Commits.
- **"Commit" = LOCAL commit only** — never `git push` or create remotes unless explicitly asked.

---

## Development Commands

```bash
# Dev server
pnpm dev

# Build
pnpm build

# Type check
npx tsc --noEmit

# Add shadcn/ui component
npx shadcn@latest add {component}
```

---

## Permissions

### Allowed
- Modify any TypeScript/TSX files under `src/`
- Add static files to `public/`
- Add dependencies via package.json (pnpm)
- Modify harness configuration under `.claude/`

### Forbidden
- No hardcoding real secrets in `.env*` files
- No direct modification of `node_modules/`
- No direct modification of shadcn/ui base components (`src/components/ui/`) — regenerate via CLI
