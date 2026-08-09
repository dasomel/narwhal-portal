# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

English | [한국어](CHANGELOG_ko.md)

## [Unreleased]

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
