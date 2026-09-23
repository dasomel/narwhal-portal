---
name: narwhal-portal-qa
description: Verify Narwhal Portal changes across API/UI response shapes, routes, RBAC/auth, cache keys, build/tests, and browser/integration behavior. Use before claiming Portal frontend, backend, or integration changes are complete.
license: Apache-2.0
compatibility: Requires the Narwhal Portal checkout and current project test/build toolchain; browser or cluster access is required for real runtime evidence.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/narwhal-portal
  openforge-maturity: verified
  openforge-version: "1"
---

# Narwhal Portal QA

## Use When

- Finishing a Portal feature/fix.
- Checking an API/UI seam, navigation, RBAC/auth, cache behavior, or cluster integration.
- Reviewing a change where modules can each compile but disagree at a boundary.

## Do Not Use When

- You still need to implement the frontend -> `narwhal-portal-frontend`.
- You still need to implement the API/client -> `narwhal-portal-backend`.

## Inputs

- Changed paths and intended behavior.
- Relevant API producers and UI consumers.
- Expected roles/routes/cache ownership.

## Workflow

1. Derive current API response shapes from the actual `NextResponse.json()` producers and compare them with current consumer types/access patterns. Do not rely on a hand-maintained route table when code can be inspected directly.
2. Derive actual dashboard routes from the App Router tree and compare against navigation links and programmatic routing touched by the change.
3. Cross-check role restrictions across navigation, tool metadata, pages, and API authorization for affected features.
4. Inspect `cacheGet`/`cacheSet` usage for key collisions and mismatched data shapes/TTL assumptions.
5. Run the repository's current type/build/test/lint commands that apply to the diff.
6. For browser/auth/session behavior, use Playwright or equivalent integration/browser evidence when available.
7. For cluster-service integrations, verify upstream contracts against the companion Narwhal repository and, when possible, the live integration path.
8. Report failures with producer/consumer locations and the smallest owning fix.

## Verification

Separate evidence into static/type/build, automated tests, browser/runtime, and live cluster/upstream integration. A successful build is not proof of RBAC, session, routing, or upstream service correctness.

## Stop / Escalate When

- The source of truth is split between Portal and cluster repositories with incompatible contracts.
- Correctness requires changing cluster-owned RBAC/OIDC/secrets from the Portal repository.
- The requested fix would weaken auth/access boundaries to make tests pass.

## References

- `AGENTS.md`
- `src/app/api/`, App Router page tree
- `src/components/nav.tsx`, `src/lib/tools.ts`
- cache/auth/secret abstractions
- companion Narwhal repository for cluster-owned contracts
