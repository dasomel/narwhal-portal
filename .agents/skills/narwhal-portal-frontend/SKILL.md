---
name: narwhal-portal-frontend
description: Implement Narwhal Portal Next.js/React UI changes with the repository's server/client component, i18n, navigation/RBAC, shadcn, and API-contract conventions. Use for pages, dashboard widgets, settings/onboarding UI, navigation, or role-based rendering.
license: Apache-2.0
compatibility: Requires the Narwhal Portal checkout, pnpm, Next.js 16 project dependencies, and repository-local Next.js documentation.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/narwhal-portal
  openforge-maturity: draft
  openforge-version: "1"
---

# Narwhal Portal Frontend

## Use When

- Adding or changing a page, component, widget, navigation item, settings/onboarding view, or role-based UI branch.
- Consuming a Portal API route from React/Next.js UI code.

## Do Not Use When

- Implementing an API/infrastructure client -> `narwhal-portal-backend`.
- Performing boundary/completion verification -> `narwhal-portal-qa`.

## Inputs

- Requested UI behavior and affected route/components.
- API response contract or existing consumer type.
- Allowed roles and translation keys.

## Workflow

1. Read `AGENTS.md` and the relevant Next.js 16 guide under `node_modules/next/dist/docs/` before relying on framework behavior.
2. Inspect the nearest existing page/component pattern and current navigation/RBAC ownership.
3. Default to Server Components. Add `"use client"` only when client-only state/effects/events require it.
4. For user-facing text, use the repository i18n system and add both Korean and English dictionary entries.
5. When adding a route/page, update navigation only when the feature should be discoverable there and preserve role restrictions.
6. Prefer existing shadcn/ui bases and Tailwind utilities. Do not hand-edit generated base components when the project workflow regenerates them.
7. Treat the API response shape as a contract; do not guess or silently reshape server data in one consumer.
8. Hand off to `narwhal-portal-qa` for build and cross-boundary checks.

## Verification

Run the repository's current type/build/test checks appropriate to the diff. For browser-visible or auth/RBAC behavior, use browser/integration evidence when available rather than treating a build as runtime proof.

## Stop / Escalate When

- The UI needs an API contract, RBAC role, route, or cluster-service behavior that does not exist in the owning source.
- The requested change would bypass existing auth/API boundaries.
- Framework behavior conflicts with repository-local Next.js documentation.

## References

- `AGENTS.md`
- `src/lib/i18n.ts`, i18n server/client helpers
- `src/components/nav.tsx`, `src/lib/tools.ts`
- nearest existing dashboard/settings/onboarding components
- repository-local Next.js 16 docs
