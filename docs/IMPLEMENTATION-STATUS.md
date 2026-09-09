# Implementation Status

Last verified: 2026-09-09 against `main`

This snapshot records functionality present on the default branch and separates implemented behavior from planned work.

## Implemented

- Next.js 16 / React 19 Narwhal IDP management portal with dashboard, onboarding, catalog/my-apps, node, cost, compliance, security, governance, architecture, templates, tools, and settings routes.
- Keycloak OIDC/NextAuth authentication, Valkey integration, OpenBao-based secret handling, in-cluster deployment/build workflows, and Skaffold/Kaniko development paths.
- API routes supporting the portal's operator/developer views and platform interactions.
- Vitest-based unit/regression test suite and TypeScript/build validation used by repository CI/harness workflows.
- Privileged node-tuning Auto-Fix exact-invocation security path: server-resolved target/arguments, canonical invocation digest, exact human approval, server-side recomputation, actor/expiry/replay validation before `runHostJob`, and approval/resolution/invocation lineage in execution evidence.

## Partial / planned

- Browser-level Playwright coverage should only be described as implemented where an actual workflow/test suite exists; the current repository's strongest verified regression evidence for the recent security path is unit/harness + type-check/build.
- Other privileged or future agent/tool surfaces must adopt the same Agent Execution Security Contract at their own real execution boundary; the node-tuning path does not automatically secure unrelated future mutations.

## Not claimed

- Portal helper libraries alone are not treated as proof of runtime authorization; the implemented claim is specifically tied to the node-tuning execution path integrated in PR #90.
- Planned UI/testing capabilities are not current behavior unless present on `main` with executable evidence.

## Evidence

- `README.md`
- `src/app/`
- `src/lib/agent-execution-security.ts`
- node-tuning API/UI routes and tests
- repository harness/unit/type-check/build verification
- PR #90 (`0e8d34cb23b052068b4ec3557ea0d486cf5623a1`)
