<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Narwhal Portal

Change workflow, risk classes, and agent-engineering standards: https://github.com/dasomel/openforge/blob/main/docs/change-management.md and https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md. Portal-specific rules below; `.agents/openforge-adoption.md` holds the local adoption note.

## Skills

Load the project skill matching the task before editing:

- pages, components, widgets, navigation, RBAC rendering, i18n: `.agents/skills/narwhal-portal-frontend/SKILL.md`
- API routes, infrastructure clients, cache, secrets, upstream integration: `.agents/skills/narwhal-portal-backend/SKILL.md`
- API/UI seams, routes, RBAC/auth, cache keys, build/browser/integration evidence: `.agents/skills/narwhal-portal-qa/SKILL.md`

`.claude/skills/idp-*` are legacy compatibility adapters; do not add workflow rules there.

## Boundaries

- Exported APIs, auth/RBAC, routing contracts, destructive actions, and shared component semantics are design changes, not routine edits.
- Do not auto-fix unrelated findings; report them separately.
- Do not hand-edit `src/components/ui/` (shadcn-generated; regenerate instead).
- The Narwhal cluster repo owns service endpoints, namespaces, secret paths, OIDC clients, RBAC bindings, and routes. Verify those assumptions in its source (normally `../narwhal`, never a maintainer-specific absolute path), treat it as read-only from Portal work, and route cluster-owned changes there. Do not copy cluster deployment config into Portal to make a local integration pass.
- Shared/production/destructive/release/credential/permission/external mutations need explicit authorization; local disposable work within scope does not.

## Verify

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `bash scripts/harness-rules.sh`, `pnpm test:e2e` (Playwright). `harness-rules.sh` is a CI ratchet on Tailwind-first styling (no static `style={{}}`) and UI text via `src/lib/i18n.ts` (no hardcoded Korean): counts may only go down, and the baselines in the script are lowered in the same commit that pays debt off.

A green build or mocked/self-authored tests do not prove browser, auth, or live-integration behavior; use Playwright/integration evidence for those paths and say which kind of evidence you have. For API/UI seams compare the real producer and consumer instead of a hand-maintained mapping.
