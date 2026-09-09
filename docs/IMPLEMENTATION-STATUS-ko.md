# 구현 상태

Last verified: 2026-09-09 against `main`

이 snapshot은 default branch의 실제 기능과 planned work를 구분합니다.

## 구현됨

- Dashboard, onboarding, catalog/my-apps, node, cost, compliance, security, governance, architecture, templates, tools, settings route를 갖춘 Next.js 16 / React 19 Narwhal IDP management portal.
- Keycloak OIDC/NextAuth authentication, Valkey integration, OpenBao secret handling, in-cluster deployment/build workflow, Skaffold/Kaniko development path.
- Operator/developer view와 platform interaction을 지원하는 API route.
- Repository CI/harness에서 사용하는 Vitest unit/regression suite 및 TypeScript/build validation.
- Privileged node-tuning Auto-Fix exact-invocation security path: server-resolved target/arguments, canonical digest, exact human approval, server-side recomputation, `runHostJob` 전 actor/expiry/replay 검증, execution evidence의 approval/resolution/invocation lineage.

## 부분적 / planned

- Browser-level Playwright coverage는 실제 workflow/test suite가 존재하는 범위에서만 implemented로 설명해야 합니다. 최근 security path의 검증된 regression evidence는 unit/harness + type-check/build입니다.
- 다른 privileged/future agent/tool surface는 각 실제 execution boundary에서 같은 Agent Execution Security Contract를 별도로 적용해야 합니다. Node-tuning path가 unrelated future mutation을 자동으로 보호하는 것은 아닙니다.

## 주장하지 않음

- Helper library 존재만으로 runtime authorization을 증명했다고 보지 않습니다. 구현된 claim은 PR #90에서 실제 node-tuning execution path와 연결된 범위입니다.
- `main`에 executable evidence가 없는 planned UI/testing capability를 현재 기능으로 주장하지 않습니다.

## Evidence

- `README.md`
- `src/app/`
- `src/lib/agent-execution-security.ts`
- node-tuning API/UI routes and tests
- repository harness/unit/type-check/build verification
- PR #90 (`0e8d34cb23b052068b4ec3557ea0d486cf5623a1`)
