<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Narwhal Portal engineering contract

Read `README.md`, `CLAUDE.md`, relevant design/architecture docs, and the issue/spec before editing. Preserve existing component, auth, API, routing, and state-management conventions.

- Make the smallest coherent change that solves the requested problem.
- Do not auto-fix unrelated findings; report them separately.
- Preserve UI/API/auth boundaries and existing access restrictions.
- Treat exported APIs, auth/RBAC changes, routing contracts, destructive actions, and shared component semantics as design changes.
- Let formatter/linter rules own deterministic style. Do not add prompt-only style rules that tooling already enforces.
- Comments explain why, invariants, compatibility constraints, or hazards; do not narrate obvious code.
- For bugs, prefer: reproduce -> failing test/evidence -> minimal fix -> same test passes -> relevant regression suite.
- Use Playwright/integration evidence for browser/auth behavior when unit tests cannot prove the real path.
- Do not claim completion without build/test/lint evidence; distinguish mocked tests from browser/runtime verification.
- End substantive work as A) complete/verified, B) meaningful verified progress with the next blocker isolated, or C) stop with evidence when further work requires unjustified scope, fragile patches, or unsupported assumptions.

Reference: https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
