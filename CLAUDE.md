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

Whenever this portal assumes something about the cluster — an endpoint, a namespace, a service
name, a secret path, an OIDC client, an RBAC role — **the cluster repo is the answer and your
recollection is not.** The rendered ArgoCD Applications under `gitops/charts/` are what actually
runs; three scripts own the portal's own seam: `11-3-keycloak-clients.sh` (OIDC clients),
`13-2-narwhal-portal-bindings.sh` (portal RBAC + API token), `15-narwhal-portal.sh` (deploy).

> Treat the cluster repo as **read-only from here**. Route cluster changes back to that repository.

### Cross-repo seam harness
When a change spans BOTH repos (a portal integration depends on a cluster contract, or you
need to verify the two are aligned), use the **`idp-cross-orchestrator`** harness at the
workspace root (`idp/.claude/`). It extracts what the cluster provides vs what this portal
assumes (endpoints, secret paths, OIDC, RBAC, PromQL, env), reports drift + security findings,
and routes fixes back to the owning harness. Single-repo portal work stays with `portal-*`.

---

## Agent Team Harness

`portal-frontend`, `portal-backend`, and `portal-qa` in `.claude/agents/`, backed by the
`idp-frontend` / `idp-backend` / `idp-qa` skills — each file states its own role and model.

The one thing the files can't tell you: **frontend and backend must be handed the same API
response-shape spec, written before either starts.** That shared spec is what makes the two lanes
safe to run in parallel, and it is what `portal-qa` checks them against afterwards (report in
`_workspace/qa_report.md`). Skip the parallelism when only one side is changing.

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

## Off-limits

Scripts live in `package.json`; the package manager is pnpm. Two things are not obvious from the
tree: `src/components/ui/` holds generated shadcn/ui bases — change them through
`npx shadcn@latest add`, not by hand — and `.env*` must never carry a real secret, since the
portal reads live cluster credentials at runtime.
