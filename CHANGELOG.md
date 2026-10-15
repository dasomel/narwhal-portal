# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

English | [한국어](CHANGELOG-ko.md)

## [Unreleased]

Hardens the portal's production posture (authenticated Valkey TLS, explicit OpenBao auth mode,
fail-fast dependency configuration, namespace-scoped reads) and makes provider failures visible
instead of silently healthy: write routes now distinguish rejected, credential and
outcome-unknown results, and platform status no longer reports green when ArgoCD or Alertmanager
cannot be read. Tags 1.0.18 and 1.0.19 were pushed but never published as GitHub Releases (the
cosign signing step failed), so this section covers everything since 1.0.17.

### Upgrade notes
- **Production now requires authenticated Valkey TLS (#205, 63603d6, after 1.0.19)**: in
  production `getValkey()` / `getLiveValkey()` (`src/lib/valkey.ts`) throw unless all of
  `VALKEY_URL=rediss://…` (TLS scheme), `VALKEY_TLS=true`, `VALKEY_USERNAME` (a dedicated ACL
  user, `portal` in the docs) and `VALKEY_PASSWORD` are set. `VALKEY_INSECURE_PRODUCTION` is no
  longer supported: if it is defined at all (even `false`) the client refuses to initialize.
  See `docs/security-clean-install.md` section 6. The failure is lazy (first Valkey use, not
  process start); with `VALKEY_URL` or `VALKEY_PASSWORD` set, `/api/health/ready` then returns
  503 (`Critical cache dependency unavailable`), so a rollout never becomes Ready. **The narwhal
  GitOps chart at the time of writing still injects `VALKEY_INSECURE_PRODUCTION=true` and a
  plaintext `redis://` URL against a Valkey without TLS or ACL, so this portal version cannot be
  deployed with it until narwhal provides Valkey TLS + ACL and matching bindings.** Images up to
  1.0.19 predate this change.
- **OpenBao static-token mode must be explicit in production (#237, 5319ada)**: in production,
  if `OPENBAO_TOKEN` is the credential in use, `OPENBAO_AUTH_METHOD` must be exactly `token`;
  otherwise the first OpenBao request throws `Static credentials require explicit
  OPENBAO_AUTH_METHOD=token in production`. The check is lazy (first OpenBao token request, not
  startup) and only reached when the auth method resolves to `token`, i.e. `OPENBAO_AUTH_METHOD`
  is unset and no Kubernetes service-account JWT is mounted. Deployments on Kubernetes auth
  (`OPENBAO_AUTH_METHOD=kubernetes`, or a mounted JWT with the variable unset) are unaffected. In
  production any other non-empty `OPENBAO_AUTH_METHOD` value (for example a typo) now throws
  `OPENBAO_AUTH_METHOD must be kubernetes or token`.
- **OpenBao address must be HTTPS on every request (#236, 513a71a)**: `OPENBAO_ADDR` is now
  validated before each outbound request and the Kubernetes login, not once per process, and a
  non-HTTPS address in production is rejected every time.
- **Production fails fast on missing dependency configuration (since 1.0.17)**: `ARGOCD_URL`,
  `ALERTMANAGER_URL`, `PROMETHEUS_URL`, `TEMPO_URL`, `LOKI_URL`, `APISIX_ADMIN_URL`,
  `OPENBAO_ADDR`, `GITEA_URL` and `KEYCLOAK_INTERNAL_URL` no longer fall back to localhost or
  in-cluster defaults (752273f, 451bec8); `KEYCLOAK_ISSUER` and `GITEA_URL` must be `https://`
  (#110); `APISIX_API_KEY_READONLY` no longer falls back to the admin `APISIX_API_KEY` (#112).
- **Kubernetes token source (since 1.0.17)**: the portal reads a projected, short-lived
  service-account token (`K8S_SA_TOKEN_FILE` to override the path) instead of `K8S_SA_TOKEN`,
  which is dev-only; setting `K8S_TOKEN_AUDIENCE` enables the client-side `aud` check and an
  unset value logs a warning in production (eeb5ef6, 1a27584, 1e35aac).
- **Namespace visibility follows the `narwhal.io/team` label (b094fb7)**: the label is the
  source of ownership; the namespace patterns in `config/role-filter.json` still resolve as a
  migration path for unlabelled namespaces. `POST /api/namespaces` no longer creates a namespace:
  it commits a tenant manifest to the GitOps repo and opens a pull request (058426e).
- **API consumers**: `/api/governance/audit` is a deprecated alias of the new
  `/api/governance/events` (#161); `/api/health/status` now requires `cluster-admin`
  (a286598); federated logout is POST-only (ab69c4f); catalog rollback, silence create/delete and
  the sync routes return new status codes and fixed error texts (see Changed).
- **Release pipeline**: tag builds sign the image with cosign and fail without the
  `COSIGN_PRIVATE_KEY` / `COSIGN_PASSWORD` repository secrets (3026d23,
  `docs/cosign-signing-setup.md`); the GitHub Release is only created after a successful
  publish (#120).

### Added
- **Aggregate dependency health for every user**: `GET /api/health/summary` returns only
  `{state, observedAt}` to any authenticated role and drives a navigation indicator (#155); the
  detailed, admin-only `/api/health/dependencies` exposes a unified dependency contract with
  informer owner state and live-pipeline counters (#148, #158, #162).
- **`/api/governance/events`**: returns `{items, truncated, evidenceKind, freshness}`; the old
  audit-named route keeps its bare array and adds `X-Truncated`, `Deprecation` and `Link`
  headers (#161).
- **Namespace requests by pull request**: namespaces are requested as a GitOps PR carrying a
  `narwhal.io/team`-labelled Namespace, a RoleBinding and a ResourceQuota (058426e).
- **Canonical event envelope and live-stream resilience**: idempotent `/api/events/ingest` with
  per-producer credentials, rate limiting (429 + `Retry-After`) and payload bounds (3344e78),
  deterministic `Last-Event-ID` replay (#154), and a single-owner Kubernetes informer through a
  Valkey lease (#158).
- **Preflight routes**: `/api/dr/restore-preflight` (#215), `/api/storage/pvc-expansion-preflight`
  (#221, #222, #223) and `/api/settings/role-mappings/preflight` for orphaned namespace patterns
  (2d44836); the DR and PVC verdicts derive from server-observed facts, never from caller input.
- **Cluster registry foundation**: `config/clusters.json`, a `cluster_id` scope dimension,
  admin CRUD at `/api/settings/clusters` (681f845) and a `/api/domain/clusters` pilot (e36a68d).
- **Shared outbound HTTP client**: timeout, bounded retry and correlation for every provider
  client, including the Kubernetes apiserver (#143, #149, #151, #152).
- **Operator UX**: a shared loading/error/empty/partial/stale `DataState` with retry and
  freshness (#156, #159), cache capture time (#157), vulnerability-DB freshness (584b797), portal
  version and commit in the navigation (#150), and a "More" menu for overflowing navigation
  items (#167).
- **User role groups on create**: `POST /api/settings/users` accepts an optional `groups` array
  limited to the portal role allowlist (#132).
- **Supply chain**: cosign image signing (3026d23), OSS attribution and a Dependency SBOM
  (2e3ffc5), and a 7-day lockfile cooling gate for new dependencies (69a4be5).

### Changed
- **Catalog rollback classifies the outcome (#245, b0c304e)**: a 4xx from ArgoCD returns that
  status with `outcome: "rejected"`; a missing or rejected ArgoCD token returns 503; a 403
  returns 403; a timeout, network error, 5xx, 408 or unreadable 2xx returns 502 with
  `outcome: "unknown"` and "verify the application status before retrying". The ArgoCD POST is
  sent once and never auto-retried. A 2xx must carry the requested Application.
- **Silence create and delete classify the outcome (#247, 486ac21)**: delete of an absent
  silence returns 404; other 4xx return that status with `outcome: "rejected"`; 401 returns 503;
  403 returns 403; timeout, network, 408, 5xx or a malformed 2xx return 502 with
  `outcome: "unknown"`. A created `silenceID` is accepted only if it matches
  `[A-Za-z0-9_-]{1,128}` and is used as returned (never trimmed).
- **Silence DELETE ownership lookup (#244, 3b4d320)**: only an explicit Alertmanager 404 reads as
  "not found"; 401 returns 503, 403 returns 403, and other failures or a malformed lookup
  response return 502 without sending the DELETE.
- **ArgoCD write precondition (#243, 7f7dc1c)**: a provider failure while checking the
  application no longer reports `Application not found`; credential errors now reach the 503
  mapping.
- **Fixed error texts on sync routes (#246, 1b9984d)**: `argocd/sync` and `catalog/[name]/sync`
  return `ArgoCD sync failed` (502) instead of the raw upstream error, and the
  `operation.failed` event description is a fixed text; rollback events follow the same rule
  (#245).
- **`/api/status` reports `degraded` when ArgoCD or Alertmanager cannot be read (#242,
  2d38cbb)**: the failed provider appears as an `unknown` component (summary suffix
  `status incomplete: … unreachable`) and the result is not cached. Environments where ArgoCD or
  Alertmanager are unconfigured or unreachable, such as local development, now show `degraded`
  instead of `healthy`.
- **Dependency health fails closed**: an aggregate over zero dependency statuses is
  `unavailable`, not `ok` (#240), and a cached snapshot is trusted only after shape validation
  (#241).
- **Kubernetes list contract (#239, 70bc7ce)**: a 200 response without an `items` array is an
  error, and `limit` / `maxPages` must be positive safe integers or the call is rejected before
  any request. Cluster-wide inventory lists are bounded and report `truncated` (4c146b7).
- **Outbound HTTP bodies and cancellation**: decoded response bodies over 8 MiB fail with a
  `response-too-large` error unless the caller raises the limit (#225); retry backoff and native
  `RequestInit` cancellation now follow the caller's abort (#228, #238).
- **Live events**: recovery after Kubernetes watch expiry applies a bounded paginated snapshot
  (#226), and the informer waits for each event to be accepted so submissions stay in flight one
  at a time (#229).
- **ArgoCD sync and rollback verify convergence**: a 2xx only means accepted; the routes re-read
  the application and return `pending: true` until `operationState` converges (#121).
- **Required CI checks**: `Portal critical regression gate` is an always-reported required check
  (#227), and a SHA-bound `independent-review` commit status gates merges (#213).
- **Dependencies**: Next.js 16.3.5 with React 19.3.0 (#170), `@base-ui/react` 1.8.0 (#212),
  `@grpc/grpc-js` 1.14.5 (#211), and grouped GitHub Actions bumps for `upload-artifact`,
  `download-artifact`, `setup-node` and `harden-runner` (#230, #233, #232, #231).

### Fixed
- **Read-scope gaps closed**: `/api/cost` (2ba8fc5) and its detail and trend routes (#123),
  `/api/governance/resources` (#147), `/api/k8s/events` (#145), `/api/catalog`, `/api/events`,
  `/api/k8s/pods` and `/api/k8s/resource` (1e48371) now filter by the caller's visible
  namespaces before any cache or upstream read; cache keys carry a scope fingerprint.
- **Silence create is scoped**: non-admin callers need an exact-match `namespace` matcher inside
  their scope, catch-all regex matchers are rejected for every role, and an optional
  `Idempotency-Key` is honored (5ce9516).
- **ArgoCD writes check the destination namespace**, not only the project (d00eff1).
- **Unknown is not healthy**: scorecards distinguish `unavailable` evidence from `fail` (#118),
  DORA reports unknown deployment outcomes and a `null` change-failure rate instead of a false
  zero (#117), cost fails closed on unconfigured pricing (e2ad866), and partial Keycloak group
  fetches are no longer presented as complete (#113).
- **Expired list continue token**: a bounded Kubernetes list restarts once on 410 (#141).
- **Kubeconfig server**: downloaded kubeconfigs use the external API server address, not the
  in-cluster one (506c279).
- **Image builds**: the Kaniko path pushes an immutable source-SHA tag with a digest file instead
  of `latest` (a874ac7), and the standalone image traces `@swc/helpers` and is smoke-booted in CI
  (#164).

### Security
- **Authenticated Valkey TLS in production** (#205; see Upgrade notes).
- **Logout hardening**: federated logout is POST-only with CSRF protection (ab69c4f), fails
  closed on unverifiable requests (a6fc4ec), and the redirect-host allowlist is anchored so
  `maliciouslocalhost` no longer passes (25381e1).
- **Credential handling**: ArgoCD and Gitea tokens are read per call and fail closed on 401
  (#134), APISIX has no silent admin fallback (#112), and Keycloak admin token acquisition is
  standardized (ea96a9a).
- **Error text no longer leaks upstream hosts or bodies** from sync and rollback responses and
  from the `operation.failed` event stream (#245, #246).
- **Privileged node tuning**: hardened Job execution boundary (3a209f7), a preflight dry-run
  (#105) and exact invocation approval at runtime (#90).
- **Supply chain**: build images pinned by digest and no Gitea password in URLs (#109), CI egress
  blocked on install-time jobs (#106), and `kubelogin` pinned with checksum verification (#104).

### Known issues
- **UI rollback returns 400**: the catalog UI (`service-actions.tsx`) sends `{historyId}` but
  `POST /api/catalog/[name]/rollback` requires `{id}`. This predates 1.0.17.
- **No idempotency for rollback**: the route never claims an `Idempotency-Key`, so retrying with
  the same key after an `outcome: "unknown"` response re-sends the ArgoCD POST.
- **Silence DELETE ownership** compares only `createdBy`, not team scope, and there is a
  lookup-to-delete race window (Alertmanager allows changing `createdBy` on the same id).
- **`ArgoForbiddenError` text** includes the ArgoCD project or namespace in the 403 body.
- **Groups and users PATCH** (`/api/settings/groups`, `/api/settings/users/[pk]`) return a bare
  `{ok: true}` without reading the change back.
- **Cluster-wide views for viewers**: `/api/governance/distribution` (any authenticated user) and
  `/api/service-graph` (viewer and above) apply no scope filter.
- **Cluster registry is a foundation only**: `/api/settings/clusters` persists to
  `config/clusters.json`, and when that file is not writable the change stays in memory and is
  lost on restart; the Kubernetes and ArgoCD clients do not yet resolve a cluster per request.
- **Release notes link**: `release.yml` links `CHANGELOG_ko.md`, but the file is
  `CHANGELOG-ko.md`.

## [1.0.17] - 2026-08-09

Fixes platform tool health checks, node role detection, compliance reporting metrics, and node infrastructure audit queries, while introducing an automated release notes workflow for version tags.

### Added
- **Automated GitHub Release workflow**: Added `.github/workflows/release.yml` to publish release notes from `CHANGELOG.md` on `v*` tag pushes, failing the job if the version section is missing.

### Fixed
- **Configurable platform tool base domain**: Added `CLUSTER_BASE_DOMAIN` (and `NEXT_PUBLIC_CLUSTER_BASE_DOMAIN`) environment variable support (defaulting to `local.narwhal.internal`) to resolve tile URLs on custom cluster domains without in-pod NXDOMAIN health check failures.
- **Node role derivation via Prometheus and K8s labels**: Derived node roles using the `kube_node_role` metric joined on node labels in Prometheus queries, and recognized both `control-plane` and legacy `master` label/taint keys in K8s API responses.
- **Compliance framework pass rate percentage scaling**: Scaled average framework pass rate by multiplying by 100 before rounding, preventing 0-1 pass rate ratios from rendering as 1%.
- **Cluster-scoped node infrastructure audit report querying**: Queried and merged cluster-scoped `clusterinfraassessmentreports` alongside namespaced `infraassessmentreports` so trivy-operator node security audit findings are properly reflected.

## [1.0.16] - 2026-07-25

Introduces a dependency-aware Platform Status page for real-time component health tracking
and optimizes container release workflows with native multi-architecture builds.

### Added
- **Dependency-aware Platform Status page**: Added the `/status` view displaying real-time
  health indicators across cluster components and underlying infrastructure dependencies.
- **Design system token contract**: Introduced `DESIGN.md` establishing design token guidelines
  and CI lint rules for frontend styling consistency.

### Changed
- **Each architecture builds on a native runner** — the 1.0.16 image never published, because
  one job built both platforms and the arm64 leg ran `next build` under QEMU: amd64 finished in
  ~90s while arm64 was still compiling five minutes later, and an earlier run reached 2h38m
  before being cancelled. Now one job per arch (`ubuntu-24.04-arm`, free for public repos)
  pushes by digest and a final job merges them into one multi-arch manifest. No QEMU anywhere.

## [1.0.15] - 2026-07-13

*Version jumped from 1.0.4 to 1.0.15 to align package versioning with the cluster GitOps image pin.*

Improves authentication stability with Keycloak OIDC session keep-alives, single-flight token
refreshing, and chunked session cookie handling, while expanding platform tools and refining
security compliance reporting.

### Added
- **Kubernetes Dashboard and NFS Quota tool tiles**: Integrated zero-click gateway SSO dashboard
  tiles for Kubernetes Dashboard 3.0 and NFS Quota management.
- **Keycloak SSO session keep-alive**: Implemented background token refresh using single-flight
  request execution to maintain active OIDC sessions without user interruption.
- **Parent-domain theme synchronization**: Shared the `narwhal-theme` cookie across the parent
  domain to keep dark/light theme preferences synchronized with Keycloak login screens.
- **Hygiene severity tier in compliance**: Added a `LOW` severity tier to the config-audit
  summary to track minor security hygiene findings separately from actionable threats.

### Fixed
- **Login redirect loop from chunked session cookies**: Updated NextAuth session cookie handling
  with a shared predicate (`isSessionCookie`) to correctly reconstruct split session cookies
  exceeding browser header size limits.
- **Compliance headline noise reduction**: Filtered built-in/upstream RBAC roles and
  system-namespace findings out of actionable headline metrics on the compliance dashboard.

## [1.0.4] - 2026-07-10

Converts core KISA security compliance controls into live Kubernetes resource audits and enhances
real-time event stream classification.

### Added
- **Live KISA security compliance checks**: Converted static compliance rules for `KISA-CP-01`,
  `KISA-ETCD-01`, `KISA-POD-01`, and `KISA-NET-01` into live cluster inspection checks with
  builtin-aware evaluation for `KISA-RBAC-01` / `KISA-RBAC-02`.

### Changed
- **Direct Gitea repository link**: Updated the Gitea platform tool tile link to navigate
  directly to the `narwhal-gitops` repository.
- **Valkey TLS bypass configuration**: Added support for `VALKEY_INSECURE_PRODUCTION` env var to
  bypass strict TLS verification in non-production environments.

### Fixed
- **Live event stream classification**: Categorized streamed K8s events to enable UI category
  filtering and surfaced warning events under critical views.

## [1.0.3] - 2026-07-09

Separates live-streaming pub/sub operations onto a dedicated Valkey connection pool.

### Fixed
- **Dedicated Valkey client for live streaming**: Created a separate Valkey client instance
  for Server-Sent Events (SSE) pub/sub channels and pipelines to prevent subscriber blocking on
  general cache operations.

## [1.0.2] - 2026-07-09

Establishes a live Kubernetes Events informer backend to feed real-time event streams into the
dashboard.

### Added
- **Kubernetes Events informer** — `/live` had no event source at all: `live-k8s-informer.ts`
  was a TODO stub that was never invoked, and nothing posted to `/api/events/ingest`, so the
  page could only ever be empty. It now runs a cluster-wide core/v1 Events watch
  (`resourceVersion` + backoff reconnect, all `Warning` events plus a curated set of `Normal`
  reasons), maps each to a `LiveEvent` and calls `pushEvent()`, which publishes to the Valkey
  pub/sub channel. Started once from `instrumentation.ts` on the Node.js runtime.

### Changed
- **Release CI build triggers**: Restricted GHCR container build workflows to tag pushes (`v*`)
  to prevent redundant untagged image builds on intermediate commits.

## [1.0.1] - 2026-07-09

Stabilizes real-time SSE stream connections, refines compliance report parsing, and cleans up
alert scorecard metrics.

### Added
- **Action-only toggle for node inspection**: Added a filter toggle to hide healthy CNI and
  control-plane info panels in node detail views, focusing on actionable items.

### Fixed
- **SSE reconnect storm**: Kept Server-Sent Events streams open during pub/sub subscriber
  failures to prevent client reconnect loops.
- **Trivy compliance report parsing**: Updated report parsing logic to read `detailReport.results`
  and accurately evaluate per-control pass/fail statuses.
- **Governance scorecard noise**: Excluded Prometheus `Watchdog` and `InfoInhibitor` synthetic
  meta-alerts from governance scorecard metric counts.

## [1.0.0] - 2026-07-07

First public release of the Narwhal IDP Portal, a Kubernetes Internal Developer Platform
management dashboard built with Next.js 16 and React 19.

### Added
- **Core Dashboard & Service Map**:
  - Live dashboard featuring real-time cluster event timelines, activity feeds, and resource summaries.
  - Interactive service dependency graph integrating Hubble relay L4/L7 eBPF network flows,
    live traffic rates, namespace filtering, node detail drawers, and visual legends.
  - Node inspection views with interactive action-needed accordion filters, system audit panels,
    and capacity metrics.
- **Application Catalog & Workloads**:
  - Application catalog and pod management views supporting streaming container logs scoped by
    `app.kubernetes.io/instance`.
  - Role-default application visibility scope (`my-apps`) with team override capabilities.
- **Security Compliance & Governance**:
  - KISA security control framework checklist (`/compliance`) with sortable tables and Trivy
    vulnerability report integration.
  - Governance dashboard featuring workload distribution analysis, pods missing resource requests,
    RBAC risk analysis, and DORA metrics.
  - On-premises actual cost-basis calculation methodology.
- **Single Sign-On & Access Control**:
  - Keycloak OIDC authentication with automatic login proxy redirection and relative `callbackUrl`
    handling.
  - RP-initiated federated logout (SLO chain) routing through the APISIX gateway (`/apisix/logout`)
    while clearing secure cookies (`__Secure-`, `__Host-`).
  - 4-tier Role-Based Access Control supporting `cluster-admin`, `developer`, `viewer`, and `guest`
    roles across navigation and platform tools.
- **Platform Tool Integration**:
  - Platform tools grid with deep links and zero-click SSO bootstrapping for ArgoCD, Grafana,
    Harbor, Gitea, OpenBao, Velero UI, and Headlamp.
- **Internationalization & Design System**:
  - Dual-language i18n support (English and Korean) with cookie-based locale switching and
    self-hosted Pretendard font for Korean typography.
  - Modern responsive UI built with Next.js 16, React 19, and Tailwind CSS.
- **Container Build & Local Development**:
  - Containerization setup supporting multi-arch Docker builds published to GHCR
    (`ghcr.io/dasomel/narwhal-portal:1.0.0`).
  - In-cluster Kaniko build Job manifest (`deploy/kaniko-build-job.yaml`) for offline clean
    installs.
  - Skaffold development profile configured for live Hot Module Replacement (HMR) and container
    file syncing.

[Unreleased]: https://github.com/dasomel/narwhal-portal/compare/v1.0.17...HEAD
[1.0.17]: https://github.com/dasomel/narwhal-portal/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/dasomel/narwhal-portal/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/dasomel/narwhal-portal/compare/v1.0.4...v1.0.15
[1.0.4]: https://github.com/dasomel/narwhal-portal/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/dasomel/narwhal-portal/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/dasomel/narwhal-portal/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/dasomel/narwhal-portal/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dasomel/narwhal-portal/releases/tag/v1.0.0
