@AGENTS.md

# Narwhal Portal Claude adapter

Repository-wide engineering rules live in `AGENTS.md`. Portable project workflows live under `.agents/skills/`. Keep this file limited to Claude-specific routing and harness behavior.

## Project skill routing

| Task | Canonical skill |
|---|---|
| pages, components, widgets, navigation, RBAC rendering, i18n | `.agents/skills/narwhal-portal-frontend/SKILL.md` |
| API routes, infrastructure clients, cache, secrets, upstream integration | `.agents/skills/narwhal-portal-backend/SKILL.md` |
| API/UI seams, routes, RBAC/auth, cache keys, build/browser/integration evidence | `.agents/skills/narwhal-portal-qa/SKILL.md` |

The legacy `.claude/skills/idp-frontend`, `idp-backend`, `idp-qa`, and `idp-orchestrator` entries are compatibility adapters only. Do not add a second copy of project workflow rules there.

## Claude-only team harness

Claude specialist agents live under `.claude/agents/`:

- `portal-frontend` — UI lane
- `portal-backend` — API/integration lane
- `portal-qa` — boundary and completion verification lane

For a change that genuinely spans frontend and backend:

1. define the shared API response-shape contract before parallel implementation;
2. run frontend/backend lanes independently when the harness supports it;
3. run QA after both complete;
4. route a QA failure back to the owning lane rather than widening both sides blindly;
5. stop after two non-converging repair loops and report the remaining blocker.

Single-side changes should not launch unrelated lanes.

## Companion Narwhal repository

Cluster-owned contracts are verified from the companion Narwhal checkout, normally resolved as `../narwhal` when both repositories share a workspace. Do not depend on a maintainer-specific absolute path.

Treat the companion repository as read-only from Portal work. Cluster-owned RBAC, OIDC, secret, endpoint, route, or deployment changes belong in Narwhal.

A workspace-level cross-repository harness may be used when present, but it is an optional runtime aid rather than a repository requirement.

## Next.js runtime note

The generated Next.js agent rule block is owned by `AGENTS.md`; this file imports it through `@AGENTS.md`. Read the relevant repository-local Next.js 16 documentation before relying on framework behavior.
