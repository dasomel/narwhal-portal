# Change: sign, attest, and gate deployment of Kaniko-built Portal images

- Change class: `D`
- Owner: (unassigned)
- Related issue: narwhal-portal#23 (remaining ACs); narwhal#35 (the platform-wide capability this
  consumes one slice of — this package does NOT attempt #35 in full)
- Status: `Draft`
- Accepted by / date: —

## Problem

narwhal-portal#23's first four acceptance criteria are done (PRs #168, #169): the Gitea admin
password no longer appears in a clone URL, build input images (kaniko executor, alpine/git) are
digest-pinned, every image maps to one source commit SHA and digest, and a build-evidence record
captures source revision, lockfile hash, builder digests, and image digest. The evidence record's
`sbom` and `signature` fields are explicit — but honest: `{"status": "not-generated"}` and
`{"status": "not-signed"}` (PR #169).

The remaining four ACs assume a working signature/attestation/verification pipeline that does not
exist yet in a form that could reject anything:

- narwhal already has a `verify-image-signatures` Kyverno `ClusterPolicy`
  (`gitops/resources/kyverno-policies.yaml`), but:
  - its `publicKeys` field holds a placeholder string
    (`MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/narwhal/cosign/trusted/signer/pub`), not a real EC
    public key — this is not committed-but-outdated, it was never populated;
  - `validationFailureAction: Audit` — a violation is logged, not blocked;
  - `required: false` on `verifyImages` — even set to `Enforce`, an image with *no* signature
    passes; the policy only rejects a signature that exists and fails verification;
  - the policy excludes the `devtools` namespace entirely, which is where narwhal-portal itself
    runs (`gitops/charts/narwhal-platform/templates/narwhal-portal-k8s.yaml`) — so the portal's own
    pod is out of scope regardless of the three points above.
- narwhal-portal's `docs/cosign-signing-setup.md` documents the **real** key-generation procedure
  for the GitHub Actions release path (`docker-publish.yml`'s `sign` job) — and is explicit that a
  human must run `cosign generate-key-pair` locally, "not in CI", because the private key must
  never touch an automated log or artifact. That step has not been run: no `cosign.pub` is
  committed in either repo, and neither `COSIGN_PRIVATE_KEY` nor `COSIGN_PASSWORD` GitHub secrets
  exist yet in narwhal-portal.
- The Kaniko in-cluster build path (`scripts/kaniko-build.sh`, `deploy/kaniko-build-job.yaml`) has
  no SBOM generation and no signing step at all — distinct from the GitHub Actions release path,
  which already signs (`docker-publish.yml`).
- No rollback UI/mechanism lets an operator pick a prior immutable digest; the deploy path already
  carries digests (build-evidence, `--digest-file`) but nothing reads them back for rollback.

## Intent

Close narwhal-portal#23's remaining four ACs for the Kaniko-built image specifically, using the
key-management model narwhal#35 already designed (static public key / trusted x509 CA, chosen for
air-gap compatibility — `docs/common/supply-chain-policy.md` §6) and the GitHub Actions path
already implements — without attempting narwhal#35's full platform-wide rollout (every
image-producing pipeline, not just the portal's).

## Scope

- In scope: SBOM generation and Cosign signing for images the Kaniko job builds; wiring the real
  (human-generated) public key into narwhal's Kyverno policy; narrowing the policy's exclusion so
  it actually covers the portal's own running pod while still exempting the Kaniko build job pod
  itself (which builds an image, it isn't one); flipping enforcement for the portal's image
  specifically; a rollback path that selects a known-good digest instead of `latest`; offline
  verification evidence.
- Affected users/systems: `scripts/kaniko-build.sh`, `deploy/kaniko-build-job.yaml` (portal);
  `gitops/resources/kyverno-policies.yaml`, `scripts/airgap/10-verify-image-signatures.sh`,
  `scripts/test/lib/check-kyverno-signed-image-policy.py` (narwhal); whatever rollback surface
  narwhal-portal or ArgoCD exposes today (needs investigation, see open questions).

## Non-goals

- narwhal#35 in full: signing every other component's image, a general SBOM→vulnerability→policy
  closed loop (narwhal#102), or moving off static-key verification.
- Generating the actual signing keypair or setting the GitHub secrets that hold it — per
  `docs/cosign-signing-setup.md`, that is a one-time **human** action, never scripted or run by an
  agent/CI. This package's implementation is blocked on that step and says so explicitly (see
  Rollout).
- Changing the GitHub Actions release path's existing signing (`docker-publish.yml`) — it already
  works; this package only extends the same model to the Kaniko path.
- Any change to `restrict-image-registries` or the other unrelated Kyverno policies in the same
  file.

## Requirements

- `REQ-001` — the Kaniko build job generates an SBOM (CycloneDX, matching the attestation
  predicate type the existing policy already expects) for the image it produces.
- `REQ-002` — the Kaniko build job signs the resulting image and attests the SBOM with Cosign,
  using the same static-key model as the GitHub Actions path (not a second, divergent key-custody
  design).
- `REQ-003` — narwhal's `verify-image-signatures` policy carries the real public key once the
  human key-generation step (already documented) is done, and its exclusion no longer blanket-
  exempts the portal's running pod.
- `REQ-004` — the deployment gate rejects an unsigned or tampered image for the portal's own
  workload specifically; the Kaniko build job pod itself remains exempt (it produces an image, it
  doesn't run one).
- `REQ-005` — build evidence's `sbom` and `signature` fields (portal#23 AC, PR #169) carry real
  references/status once generated, instead of the current honest `not-generated`/`not-signed`.
- `REQ-006` — an operator can select a prior known-good image digest for rollback instead of
  relying on `latest` or the current tag.
- `REQ-007` — `scripts/airgap/10-verify-image-signatures.sh`'s offline verification path succeeds
  against the real key and a signed portal image, using only imported trust material (no Rekor/
  Fulcio reachability).

## Acceptance scenarios

### `AC-001` — Kaniko-built image carries a real signature and SBOM attestation

- Covers: `REQ-001`, `REQ-002`, `REQ-005`
- Given the human key-generation step has been completed and the resulting `cosign.pub` is
  committed (narwhal-portal) and mirrored into narwhal per `docs/cosign-signing-setup.md`
- When the Kaniko job builds and pushes an image
- Then `cosign verify` against the real public key succeeds for that image, `cosign verify-attestation --type cyclonedx` succeeds, and the build-evidence record's `sbom`/`signature` fields
  reference the real artifacts, not `not-generated`/`not-signed`

### `AC-002` — the portal's own pod is verified; the Kaniko build job pod is not blocked by its own check

- Covers: `REQ-003`, `REQ-004`
- Given the narrowed `verify-image-signatures` policy is in `Enforce` with `required: true` for
  the portal's workload
- When the portal deployment rolls out a signed, attested image
- Then admission succeeds; when it is given an unsigned or re-tagged/tampered image, admission is
  rejected — and the Kaniko build job's own pod (which never carries a pre-existing signature,
  since it's what produces the signature) is unaffected by this rule

### `AC-003` — rollback selects a known-good digest

- Covers: `REQ-006`
- Given a prior build's evidence record with a valid, previously-verified image digest
- When an operator initiates rollback
- Then the deployment is updated to that specific digest (`image@sha256:...`), not `latest` or a
  mutable tag, and the resulting pod passes the same signature/attestation admission check

### `AC-004` — offline verification succeeds with no live Rekor/Fulcio reachability

- Covers: `REQ-007`
- Given an air-gapped bundle carrying the real public key (per
  `docs/cosign-signing-setup.md`'s suggested `scripts/airgap/keys/cosign.pub` convention)
- When `10-verify-image-signatures.sh` runs against a signed portal image with network egress
  blocked except the bundle/registry
- Then verification succeeds using only the imported key — no external transparency-log call

## Architecture and decisions

- Relevant ADR/design links: `docs/common/supply-chain-policy.md` §6 (narwhal) already made the
  keyless-vs-static-key decision (static key, for air-gap) — this package inherits it rather than
  re-deciding it.
- ADR threshold result: `not required` for the signing-model choice (already decided in §6);
  `flag` for the namespace-exclusion redesign below — small enough it may not need a formal ADR,
  but the reviewer should confirm.
- Alternatives and important trade-offs:
  - **Where SBOM generation runs**: inside the Kaniko job pod (adds a container/step to
    `deploy/kaniko-build-job.yaml`, keeps everything in one place) vs. a separate post-build Job
    triggered after Kaniko succeeds (smaller blast radius per pod, but adds a second Job to
    coordinate and a window where the pushed image is unsigned). Leaning toward inside the Kaniko
    job's pipeline (same pattern the GitHub Actions `sign` job already uses: build, then sign, in
    one job) — keeps one signing model instead of two.
  - **Namespace exclusion redesign**: Kyverno's `exclude.any.resources.namespaces` is
    namespace-wide; narrowing to "devtools minus the portal's own pod" needs either (a) a label-
    based exclude/match instead of namespace-based (the kaniko job already carries
    `app.kubernetes.io/name: kaniko-build-narwhal-portal`; the portal deployment carries its own
    distinct label), or (b) moving the portal's pod to a different namespace (larger, riskier
    change touching RBAC/NetworkPolicy/DNS that #113/#251-style narrowing work in this codebase
    has repeatedly shown is not "just a label"). Leaning toward (a): flip the policy from
    namespace-exclude to a positive label-match on workloads that should be verified, so adding a
    new signed component later doesn't require another namespace carve-out.
  - **Signature required for which workloads**: setting `required: true` cluster-wide (not just
    for the portal) is explicitly narwhal#35's job, not this package's — scoping `required: true`
    to just the portal's own workload (via the same label-match) avoids accidentally enforcing
    unsigned-image rejection for every other unsigned component in the cluster before #35 is ready
    for them.

## Change impact

| Area | Impact / evidence needed |
|---|---|
| Source / API / command | `scripts/kaniko-build.sh`, `deploy/kaniko-build-job.yaml` (SBOM + sign steps); rollback surface — TBD, see open questions |
| Dependencies / lockfiles | Kaniko job image needs `cosign` and an SBOM generator (e.g. `syft`) available — likely a new init/sidecar container with a pinned, digest-referenced image, following the existing kaniko-executor/alpine-git pinning convention (#254/#261) |
| Runtime / toolchain | New signing/attestation step adds build-job wall-clock time; needs a timeout budget check against `JOB_TIMEOUT` (`scripts/kaniko-build.sh`) |
| CI / CD | narwhal's `check-kyverno-signed-image-policy.py` (R74–R76) currently asserts the policy exists in some valid shape — audit whether it needs to start asserting a *real* key format, not just presence, once this lands |
| Release / packaging | GitHub Actions release signing (`docker-publish.yml`) is unaffected — this only extends the same model to the Kaniko path |
| Generated output | Build-evidence JSON schema (PR #169) gains real `sbom`/`signature` values; consumers of the "not-generated"/"not-signed" literal strings (if any exist — grep before assuming none do) need updating |
| Security / supply chain | This *is* the security change. The private key never enters this repo's automation — CI/agent-run steps only ever use the public key or a securely-injected signing credential the human already provisioned, matching the GitHub Actions path's existing `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` secret pattern |
| Offline / air-gap | `10-verify-image-signatures.sh` and the airgap bundle's key material path (`scripts/airgap/keys/cosign.pub`, per `docs/cosign-signing-setup.md`) — confirm the bundle-build script actually copies it once the file exists |
| Documentation / operations | `docs/common/supply-chain-policy.md` gains a note that the portal is the first Enforce-mode consumer of the design in §6; `docs/cosign-signing-setup.md` gains the narwhal-side key-mirroring step if not already precise enough |
| Portfolio / downstream repositories | narwhal-portal#23 and narwhal#35 both get a progress comment linking this package once accepted |

## Verification plan

| Acceptance ID | Verification method | Environment | Expected evidence |
|---|---|---|---|
| `AC-001` | Live build via the Kaniko job against a real cluster with the real key present | Live cluster (currently the Vagrant 6-VM cluster; Kakao is destroyed) | `cosign verify` / `verify-attestation` output; build-evidence JSON diff |
| `AC-002` | Live admission test: deploy the portal with a signed image (succeeds), then attempt an unsigned/re-tagged image (rejected); confirm the Kaniko job pod itself still schedules | Live cluster | `kubectl describe` admission events for both cases |
| `AC-003` | Live rollback exercise to a specific prior digest, confirm the resulting pod's running image digest matches | Live cluster | `kubectl get pod -o jsonpath` image digest before/after |
| `AC-004` | Airgap-isolated node per `scripts/test/airgap-isolate-kakao.sh`-style network block, run `10-verify-image-signatures.sh` | Live cluster, network path blocked except bundle/registry | Script PASS output with a REJECT-not-DROP egress test confirming no external call was attempted |

Every AC here needs live-cluster evidence, not static/unit proof alone — this repo's own lessons
(narwhal#251's RBAC gaps, narwhal#261's skopeo rejection, portal#178's outage-recovery gaps) show a
green static suite has repeatedly missed exactly this class of defect on security/admission paths.

## Rollout, rollback and recovery

- Rollout sequence, in order (each step blocks the next):
  1. **Human step (blocking, not scriptable here):** run `cosign generate-key-pair` locally per
     `docs/cosign-signing-setup.md`, commit `cosign.pub` to narwhal-portal, set
     `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` GitHub secrets, mirror `cosign.pub` into narwhal at
     `scripts/airgap/keys/cosign.pub`.
  2. Wire the real key into `gitops/resources/kyverno-policies.yaml`'s `publicKeys` field (narwhal
     PR), still in `Audit` mode — proves the key format and attestor config are valid before
     anything can be rejected.
  3. Add SBOM generation + signing to the Kaniko job (portal PR) — the image is now really signed,
     policy still Audit, so nothing is at risk yet.
  4. Narrow the exclusion to a label-match and flip to `Enforce`/`required: true` **for the
     portal's workload only** (narwhal PR) — the first point anything can actually be blocked.
  5. Rollback-by-digest mechanism (portal PR, or narwhal GitOps change depending on where the
     rollback surface actually lives — see open questions).
  6. Airgap bundle key-copy verification (narwhal PR, if the bundle script doesn't already pick up
     the mirrored key path automatically).
- Rollback trigger and procedure: if step 4's admission failures cause a portal outage, revert only
  step 4 (drop back to `Audit` or restore the broader exclude) — the earlier steps (real key
  present, image actually signed) stay in place and are not the risk.
- Data/configuration recovery: none beyond standard GitOps revert; no data-plane state involved.
- Compatibility or migration obligations: any existing running portal image predating step 3 has no
  signature — step 4 must not be flipped until at least one freshly-built, signed image has
  successfully deployed, or the very next admission event after Enforce is a self-inflicted outage.

## Evidence and durable synchronization

- Evidence location/format: `.agents/evals/traces/` on the portal side for the Kaniko job changes
  (`scripts/airgap/**`-adjacent risk if the SBOM/sign step touches anything under that path on the
  narwhal side — check `.agents/evals/risk-policy.json` per repo at implementation time); build-
  evidence JSON already exists as the durable per-build record (PR #169).
- Tests or checks that become durable regression controls: extend
  `scripts/test/lib/check-kyverno-signed-image-policy.py` (narwhal) to assert the key is not the
  placeholder string; a portal-side test asserting the Kaniko job manifest includes the sign/SBOM
  steps (matching the style of the existing digest-pin checks from #254/#261).
- Documentation to update: `docs/common/supply-chain-policy.md` (narwhal), `docs/cosign-signing-
  setup.md` (portal), both lessons-logs once real defects surface during implementation.
- ADR/evidence/portfolio records to update: comment on narwhal-portal#23 and narwhal#35 once
  accepted and again once each rollout step lands.

## Review record

- Accepted scope/requirements: *(pending — Draft; needs explicit acceptance before implementation
  per this repo's and narwhal's Class D workflow)*
- Material changes after acceptance and re-review: —
- Open questions or blockers:
  - **The human key-generation step is the actual blocker.** Nothing past step 1 in Rollout can
    proceed until it's done. This package can be reviewed and accepted now; implementation cannot
    start on steps 2+ until then.
  - Where does "rollback" actually live today for the portal — is there an existing ArgoCD
    rollback affordance, a portal admin-UI action, or does this need a new one? `AC-003`/`REQ-006`
    assume a mechanism exists to extend; if none does, this package's scope needs to grow to
    include building one, which changes its size materially.
  - Does Kyverno's `exclude`/`match` in the deployed Kyverno version actually support a clean
    label-based carve-out at the granularity needed (portal deployment vs. kaniko job, same
    namespace), or does something about how the two are labeled today need to change first?
  - Should the SBOM/sign step be a container added to the existing Kaniko Job, or a distinct
    follow-up Job — affects `JOB_TIMEOUT` budget and failure-isolation (a signing failure
    shouldn't be indistinguishable from a build failure in logs/evidence).
