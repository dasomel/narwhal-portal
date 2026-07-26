# Narwhal IDP Portal — Claude Code Guide

> Kubernetes Internal Developer Platform Portal — Next.js 16 + React 19

## Quick Overview

Management portal for the Narwhal Kubernetes cluster IDP. Provides dashboard (metrics, ArgoCD, alerts), settings (users/routes/certificates/policies), onboarding (kubeconfig, guide), and platform tools grid.

> Substantive work follows the global `<procedural_completion>` doctrine.

---

## Companion Cluster Repository

This portal is the **frontend/management UI for the Narwhal cluster**. Both repos live under
the same IDP workspace; the cluster source is the sibling directory:

```
/Users/m/Documents/IdeaProjects/20.dasomel/idp/narwhal
```

Whenever this portal assumes something about the cluster — an endpoint, a namespace, a service
name, a secret path, an OIDC client, an RBAC role — **the cluster repo is the answer and your
recollection is not.**

| Path (under `narwhal/`) | Purpose |
|------|---------|
| `gitops/charts/narwhal-apps/templates/` | ArgoCD Applications — source of truth for deployed cluster apps (rendered by the app-of-apps Helm chart) |
| `gitops/charts/narwhal-platform/templates/` | Platform manifests incl. the portal's K8s resources (`narwhal-portal-k8s.yaml`) and APISIX routes |
| `gitops/apps/` | `app-of-apps.yaml` only (points ArgoCD at `charts/narwhal-apps`) |
| `gitops/resources/` | Raw manifests incl. the ClusterRole/RoleBinding sources |
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

> Treat the cluster repo as **read-only from here**. Route cluster changes back to that repository.

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

The shared **API response-shape spec** must be written before either lane starts — that is what
makes frontend and backend safe to run in parallel, and what `portal-qa` checks them against
afterwards (report in `_workspace/qa_report.md`). If only one side changes, run only that agent.

---

## Critical Rules

### Next.js 16 Mandatory

The rule below is imported from `AGENTS.md`, which Next.js generates between
`BEGIN/END:nextjs-agent-rules` markers — edit it there, not here. Claude Code does **not**
discover project `AGENTS.md` on its own (canary-verified 2026-07-25), so this import is the only
thing that makes it load; `agyp` expands it the same way for agy worker lanes. Don't remove it.

@AGENTS.md

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
- New UI text must use the i18n system. ~48 hardcoded Korean strings predate this rule
  (`architecture/`, `catalog/`, `cost/`, `governance/`); `scripts/harness-rules.sh` blocks the
  count from growing. Korean in comments/JSDoc is fine.
- Shared translations: `src/lib/i18n.ts` (dictionaries + `t()` function + types)
- Server components: `import { getLocale } from "@/lib/i18n-server"` then `t(locale, "key")`
- Client components: `import { useT } from "@/lib/i18n-client"` then `const t = useT(); t("key")`
- Locale stored in cookie (`locale`), default `ko`. Switcher in nav bar.
- When adding new UI text, add keys to both `ko` and `en` dictionaries in `i18n.ts`.

### UI Convention
- Prefer shadcn/ui components. If missing, run `npx shadcn@latest add {component}`.
- Tailwind utilities for anything static. `style={{}}` only for values computed at runtime
  (a colour from data, a width from a percentage) — Tailwind cannot express those. The
  `scripts/harness-rules.sh` ratchet blocks the count from growing past its baseline.

### Commit Policy
- **Commit after each task** (once complete + verified), scoped to the files it touched, Conventional Commits.
- **"Commit" = LOCAL commit only** — never `git push` or create remotes unless explicitly asked.

---

## Development Commands

```bash
pnpm dev                          # dev server
pnpm build                        # production build
npx tsc --noEmit                  # type check
npx shadcn@latest add {component} # add a shadcn/ui component
```

---

## Permissions

**Allowed**
- Any TypeScript/TSX file under `src/`
- Static files added to `public/`
- Dependencies via `package.json` (pnpm)
- Harness configuration under `.claude/`

**Forbidden**
- `src/components/ui/` holds generated shadcn/ui bases — change them through
  `npx shadcn@latest add`, not by hand.
- `.env*` must never carry a real secret; the portal reads live cluster credentials at runtime.
  `.gitignore` covers `.env*` only softly (opt-in commit is allowed) and no secret scan runs in
  CI, so nothing catches a mistake here.
- Never hand-edit `node_modules/`; add dependencies with pnpm.
