# dasomel/openforge#54: narwhal-portal-backend replay

Replay date: 2026-09-24
Revisions: narwhal-portal `816e958` (origin/main), narwhal `72102a7` (origin/main), cloned as
a sibling checkout (`../narwhal`) for the first time in this repository's replay history.
Fresh agent session, no prior repository-specific memory; only `AGENTS.md`/`CLAUDE.md` and the
task were used to select the skill.

## Scope

`.agents/skills/narwhal-portal-backend/SKILL.md` (`openforge-maturity: draft` before this
replay, `openforge-version: 1`). Tracks dasomel/openforge#54 and the project-local tracking
issue dasomel/narwhal-portal#92 (closed; its acceptance criteria are the bar used below).

Prior state (per openforge#54's 2026-09-17 comment): "narwhal-portal-backend — route/auth
logic replays correctly, but skill's own step 2 (companion Narwhal cluster-contract check)
untestable single-repo; note narwhal is now cloned as a sibling, so a re-run can close this."
This replay clones narwhal as a sibling (per this issue's setup instructions) specifically to
close that gap.

## Step 1 — Activation match

Task given: "a concrete backend change exercised through the skill's own steps... API routes,
infrastructure clients, cache, secrets, upstream integration." `narwhal-portal-backend`'s
description: "Implement Narwhal Portal API routes and infrastructure clients while preserving
API shapes, auth/secrets, Valkey cache behavior, and cluster-service contracts. Use for
Next.js API routes, Keycloak/ArgoCD/APISIX/Prometheus/Alertmanager/OpenBao integrations, or
server-side cache changes." Direct match, no hidden context or path hint required. `CLAUDE.md`'s
routing table also maps "API routes, infrastructure clients, cache, secrets, upstream
integration" to this exact skill.

## Step 2 — Happy path (real change, scratch-only)

Chose `src/app/api/settings/routes/route.ts` + `src/lib/apisix-client.ts` (existing
APISIX-admin infra client, cache-backed, exactly the class of change the skill targets).

Followed the workflow literally:
1. Read `AGENTS.md` (portal) — done.
2. **Step 2 of the skill (companion Narwhal cluster contract check)** — verified for real
   against the sibling checkout instead of memory:
   - `narwhal/scripts/cluster/13-2-narwhal-portal-bindings.sh:591` sets
     `APISIX_ADMIN_URL="http://apisix-admin.platform-system.svc.cluster.local:9180"`.
   - `narwhal/gitops/resources/apisix-admin-ingress-policy.yaml` restricts port 9180 ingress
     to the `apisix-ingress-controller` and to pods matching
     `namespaceSelector: devtools` + `podSelector: {app: narwhal-portal}`.
   - `narwhal/gitops/charts/narwhal-platform/templates/narwhal-portal-k8s.yaml:7` deploys the
     Portal's ServiceAccount/Deployment into `namespace: devtools`.
   - All three agree: namespace, port, and caller identity are internally consistent between
     the two repositories. `src/lib/apisix-client.ts`'s `getDependencyUrl("APISIX_ADMIN_URL", ...)`
     dev-default (`http://localhost:9180`) is a local-only fallback and does not conflict with
     the cluster value. **This closes the exact blocker the 2026-09-17 replay left open** —
     the check is real and passed with the sibling present, not merely "no longer blocked."
3. Defined an explicit response shape: exported `ApisixRoute` from `apisix-client.ts` (it existed
   but was unexported, so the route handler cached with `cacheGet<any[]>` instead of the real
   shape) and typed the route handler's cache read as `cacheGet<ApisixRoute[]>`.
4. Preserved the infra-client boundary (no direct upstream fetch added to the route file).
5. Left the existing cache read → upstream fetch → cache write shape untouched.
6. Cache key (`api:routes-list`) already resource-scoped; untouched.
7. Secrets already read through `apisix-client.ts`'s existing accessor; untouched.
8. Failure mapping (500 on unexpected error, credential errors distinguished) already present;
   untouched.

Evidence:
```
$ pnpm typecheck
> tsc --noEmit
(exit 0, no errors)

$ pnpm test
 Test Files  60 passed (60)
      Tests  619 passed (619)
```

This is a genuine, compiling, passing change — but it is a type-safety tightening, not a bug
fix (nothing was broken before it; `any[]` erased the shape but produced identical runtime
behavior). Per this issue's instruction ("do not commit functional code changes to the PR
unless they are genuine bug fixes found by the replay"), it was **reverted** after evidence was
captured (`git checkout -- src/lib/apisix-client.ts src/app/api/settings/routes/route.ts`) and
is not part of this PR's diff.

## Step 3 — Failure/edge case (real project-specific hazard)

The skill's Stop/Escalate clause names "A route would bypass current auth/access boundaries or
expose sensitive upstream errors" and its workflow step 7 says secrets must go through the
existing abstraction, "not invent a second secret-loading path." `apisix-client.ts` carries a
named historical hazard in its own comments: Portal#54 previously let `apisixReadonlyKey()`
silently fall back to the **admin** (write-scoped) key in production whenever
`APISIX_API_KEY_READONLY` was unset, so a missing read-only key silently ran reads with full
write privilege. That fix (the `isProduction()` guard that now throws `ApisixCredentialError`
instead of falling back) is exactly the kind of privilege-boundary regression this skill exists
to prevent.

Injected the historical regression back in, on the same scratch diff:
```diff
 function apisixReadonlyKey(): string {
   const key = process.env.APISIX_API_KEY_READONLY
   if (key) return key
-  if (!isProduction()) return apisixAdminKey()
-  throw new ApisixCredentialError(
-    "APISIX_API_KEY_READONLY is not configured. Set APISIX_API_KEY_READONLY to a read-only scoped API key."
-  )
+  return apisixAdminKey()
 }
```

```
$ pnpm test
 FAIL  src/lib/apisix-client.test.ts > apisix-client credential handling >
   throws ApisixCredentialError in production when APISIX_API_KEY_READONLY is unset,
   without calling fetch
AssertionError: promise resolved "[]" instead of rejecting
 Test Files  1 failed | 59 passed (60)
      Tests  1 failed | 618 passed (619)
 ELIFECYCLE  Test failed.
$ echo $?
1
```

Real, uncoerced non-zero exit (1), caught by a test the repository already owns (not written
for this replay). Reverted (`git checkout -- src/lib/apisix-client.ts`); `pnpm test` returned to
60/60 files, 619/619 tests passing, `git status --short` clean.

## Step 4 — Deterministic verification entrypoints

The skill names no single `make verify`; the repository's own CI (`.github/workflows/test.yml`,
`build-check.yml`) is the deterministic source of truth for "the repository's type/build/test
checks," so all three were run for real:

```
$ pnpm typecheck        # exit 0, no output
$ pnpm test             # 60 files / 619 tests passed
$ pnpm build            # next build succeeded
$ ls .next/standalone   # present — matches build-check.yml's own assertion step
```

Also ran the pinned OpenForge contract auditor (`agent-contract.yml`'s exact revision,
`44d7efc`) against the working tree:

```
$ python3 audit-agent-skills.py .
SKILL .agents/skills/narwhal-portal-backend/SKILL.md: name=narwhal-portal-backend
  scope=project maturity=draft lines=61
```

The same run also printed `SKILL-DUP-NAME`/`SKILL-CASE` errors for every project skill's
`skill.md` (lowercase) alongside its real `SKILL.md`. This is a **local artifact of macOS's
case-insensitive filesystem**, not a repository defect: `git ls-files` shows only the real
`SKILL.md` per directory, and CI (`agent-contract.yml`) runs on `ubuntu-latest`, whose ext4
checkout is case-sensitive and would not produce a `skill.md` entry at all. Recorded here so it
is not mistaken for a real portfolio-audit finding; not fixed (nothing to fix — no such file
exists in the repository).

## Step 5 — Skill text defects

None found. Cross-checked every claim in `narwhal-portal-backend/SKILL.md` against the real
tree: `src/app/api/**` exists as described, `src/lib/` clients exist (`apisix-client.ts`,
`argocd.ts`, `keycloak-client.ts`, `openbao.ts`, `prometheus.ts`, `alertmanager.ts`), the Valkey
cache abstraction (`src/lib/valkey.ts`) and secret-reading pattern match the workflow's
description, and the companion-Narwhal reference resolves as `../narwhal` exactly as
`AGENTS.md`/`CLAUDE.md` specify. The Verification section's wording ("Run the repository's
type/build/test checks... state when the change is verified only against static/mocked
behavior") is intentionally the same house phrasing already used — and already
`verified` — in `narwhal-portal-frontend` and `narwhal-portal-qa`; not a defect, a consistent
convention. No path, filename, or command in this skill is stale. No SKILL.md text changes were
needed beyond the maturity field itself.

## What this replay does not prove

- No live cluster or live upstream service (real APISIX/Keycloak/ArgoCD/Prometheus/OpenBao) was
  reachable in this environment; the companion-contract check above is a real, static,
  source-to-source comparison across two repositories, not a live network/auth handshake. That
  live tier is explicitly owned by `narwhal-portal-qa` ("For cluster-service integrations,
  verify upstream contracts against the companion Narwhal repository and, when possible, the
  live integration path") and by `narwhal-cluster-debug`, not by this skill.
- No browser/session/RBAC runtime evidence was gathered; this skill's own "Do Not Use When"
  explicitly routes "Final cross-boundary verification" to `narwhal-portal-qa`.
- The happy-path change was a real, passing, revertable diff, not a shipped feature; it exists
  only to exercise the skill's steps, per this issue's instructions.

## CI-enforced evidence artifact

The first push of this PR's branch failed `agent-contract.yml` (`OpenForge agent contract`)
with `ERROR SKILL-VERIFICATION-EVIDENCE: verified skill requires
.agents/skill-evals/narwhal-portal-backend.json` — the pinned `audit-agent-skills.py@44d7efc`
enforces the stricter policy from openforge#54's own comment thread (openforge#56: "`verified`/
`stable` now require `.agents/skill-evals/<skill>.json` using
`openforge-agent-skill-verification/v1`"), which this replay's first pass missed. Added
`.agents/skill-evals/narwhal-portal-backend.json` following the same schema already used by the
sibling `narwhal-portal-frontend.json`/`narwhal-portal-qa.json` evidence files, referencing this
document's happy-path/edge-case sections and the three deterministic checks above. Re-ran the
audit script locally against the corrected tree and confirmed no `SKILL-VERIFICATION-*` finding
remains (the only residual findings are the macOS case-insensitive-filesystem duplicates
described above, which do not reproduce on the Linux CI runner).

## Decision

`openforge-maturity`: **draft -> verified**.

Rationale: every step this skill's own scope claims responsibility for — API-route/infra-client
authoring pattern, response-shape discipline, cache/secret boundary preservation, and the
companion Narwhal cluster-contract check — was replayed with real, current-source evidence, one
real project-specific hazard (the Portal#54 credential-fallback regression) was injected and
caught non-zero by the repository's own existing test, and the specific blocker the previous
(2026-09-17) replay recorded — the cluster-contract check being untestable single-repo — is now
closed for real with the sibling checkout. This mirrors the evidence strength that already
promoted `narwhal-portal-frontend` and `narwhal-portal-qa` to `verified` in this same repository
(static/type-check-level regression evidence, live-cluster/browser tier explicitly named as a
separate, not-yet-exercised axis owned by other skills).
