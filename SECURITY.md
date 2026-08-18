# Security Policy

This is the management UI for the [Narwhal](https://github.com/dasomel/narwhal) Kubernetes IDP. It
holds no data of its own: it reads the cluster with a ServiceAccount token and authenticates users
against that cluster's Keycloak. A finding here usually means the portal exposed something the
cluster already had, so the cluster repository's
[`docs/common/security.md`](https://github.com/dasomel/narwhal/blob/main/docs/common/security.md)
is often the other half of the picture.

## Reporting a vulnerability

**Use [GitHub private vulnerability reporting](https://github.com/dasomel/narwhal-portal/security/advisories/new).**
It is enabled here and keeps the report private until a fix is published. Please do not open a
public issue for a security problem.

A useful report says which route or API endpoint, which of the four roles
(`cluster-admin` / `developer` / `viewer` / `guest`) is required to reach it, and whether the issue
is reachable **before** authentication — the portal sits behind an APISIX gateway that enforces
OIDC, so pre-auth reachability changes the severity substantially.

You will get an acknowledgement within a week. This is a single-maintainer project.

## Supported versions

| Version | Status |
|---|---|
| 1.0.x | Supported — the deployed tag is pinned in the cluster's GitOps repository |
| < 1.0 | Not supported |

The image is pinned by SemVer tag in the cluster repository, so upgrading means bumping that pin,
not pulling a moving tag.

## What this project already does

- **Secret scanning and push protection** are enabled on this repository.
- **The published image carries an SBOM and provenance.** Every `v*.*.*` build attaches an SPDX
  document and a `slsa.dev/provenance/v1` predicate per architecture. Verify with:
  ```bash
  docker buildx imagetools inspect --raw ghcr.io/dasomel/narwhal-portal:1.0.17
  ```
  The `unknown/unknown` entries in the manifest list are those attestations.
- **Images are built on native runners**, one architecture each, with no QEMU emulation, and the
  tag is asserted to match `package.json` before anything is pushed.
- **Actions are pinned to commit SHAs** so a moved tag cannot change what runs in CI, and
  Dependabot keeps those pins current.
- **Dependency changes are verified**: `build-check.yml` runs a frozen-lockfile install, type-check
  and build on any change to `package.json`, `pnpm-lock.yaml`, `next.config.ts`, `tsconfig.json` or
  the `Dockerfile`.
- **No credential is committed.** Runtime configuration arrives from the `narwhal-portal-secrets`
  Secret; `.env*` files are for local development and must never carry a real secret.
- **The dependency graph is inventoried and its licenses are gated.** `license-and-sbom.yml`
  regenerates `THIRD-PARTY-NOTICES.md` and fails on a stale file, stops CI on a license that is
  neither permissive nor explicitly accepted, and publishes CycloneDX and SPDX SBOMs of the
  dependency tree; each release attaches the CycloneDX document alongside `LICENSE` and `NOTICE`.
  This is a supply-chain control as much as a legal one — an unexpected package shows up as a
  diff in a reviewed file.

## Known and accepted

- **`AUTH_MOCK` exists for local development** and bypasses authentication entirely. It is guarded:
  `src/lib/auth.ts` throws at module load if it is enabled while `NODE_ENV=production`. Reports
  that it bypasses auth in development are expected behaviour.
- **The portal reads broadly.** Its ClusterRole grants read across many resources because that is
  what a platform dashboard displays. Verbs are read-only; a report that it can *read* something
  is only a finding if that data should not reach the role viewing it.
- **`next-auth` is on a 5.0 beta.** This is a deliberate pin — the v5 line is what supports the
  App Router — and it is tracked in the cluster repository's `VERSIONS.md`.

## Limitations

- Single maintainer; no guaranteed fix window.
- No end-to-end security test suite. Auth flows are verified against a live cluster by hand.
- Release artifacts are not signed beyond the build provenance described above.
