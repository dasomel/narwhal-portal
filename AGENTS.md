<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing framework-dependent code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Narwhal Portal engineering contract

Inspect repository guidance, design/architecture context, project skills, and the issue/spec relevant to the current task before editing. Do not preload unrelated documentation or skills. Preserve existing component, auth, API, routing, and state-management conventions.

## Work contract

- Make the smallest coherent change that solves the requested problem.
- Do not auto-fix unrelated findings; report them separately.
- Preserve UI/API/auth boundaries and existing access restrictions.
- Treat exported APIs, auth/RBAC changes, routing contracts, destructive actions, and shared component semantics as design changes.
- Let formatter/linter rules own deterministic style. Do not add prompt-only style rules that tooling already enforces.
- Comments explain why, invariants, compatibility constraints, or hazards; do not narrate obvious code.

## Companion Narwhal cluster contract

The Portal consumes contracts owned by the Narwhal cluster repository: service endpoints, namespaces, secret paths, OIDC clients, RBAC bindings, routes, and other deployment details.

- Verify those assumptions from the companion Narwhal source rather than memory.
- When both repositories are checked out in one workspace, resolve the companion repository relatively (normally `../narwhal`) or through the workspace configuration; do not encode a maintainer-specific absolute path.
- Treat the companion Narwhal repository as read-only during Portal work. Route cluster-owned mutations to that repository instead of editing it from the Portal task.
- Do not duplicate cluster deployment configuration in Portal merely to make a local integration pass.

## Bug fixes and verification

- Prefer: reproduce -> failing test/evidence -> minimal fix -> same test passes -> relevant regression suite.
- Use Playwright/integration evidence for browser/auth behavior when unit tests cannot prove the real path.
- For API/UI seams, compare the actual producer and consumer contracts instead of relying on a stale hand-maintained mapping.
- Choose verification proportional to task risk and user impact. A green build or self-authored test suite is not sufficient proof of browser/auth/live-integration behavior when those paths are affected.
- Safe local/disposable inspect-edit-build-test-fix-retest work may proceed within scope. Shared/production/destructive/release/credential/permission/external mutations require explicit authorization unless already granted.
- Do not claim completion without relevant evidence; distinguish mocked/static evidence from browser/runtime and live integration verification.

## Convergence

End substantive work as A) complete/verified, B) meaningful verified progress with the next blocker isolated, or C) stop with evidence when further work requires unjustified scope, fragile patches, or unsupported assumptions.

References:
- https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
- https://github.com/dasomel/openforge/blob/main/docs/model-agnostic-agent-instructions.md
- https://github.com/dasomel/openforge/blob/main/docs/user-centric-validation.md
- https://github.com/dasomel/openforge/blob/main/docs/agent-skills.md
