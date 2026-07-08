# Narwhal IDP Portal

English | [한국어](README_ko.md)

Management portal (Next.js) for the **Narwhal Kubernetes Internal Developer Platform (IDP)**
cluster. Sibling repo `../narwhal` provisions the cluster itself (GitOps, SSO, monitoring,
storage); this repo is the web UI operators and developers use to observe and operate it.

Served in-cluster at **https://portal.local.narwhal.internal** via the cluster's APISIX gateway.

## Key Features

- **Dashboard** — cluster health, ArgoCD app status, alerts (`src/app/(dashboard)/page.tsx`)
- **Onboarding** — kubeconfig issuance, getting-started guide (`onboarding/`)
- **Catalog / My Apps** — deployed service catalog, per-user app view (`catalog/`, `my-apps/`)
- **Nodes** — cluster node inventory and status (`nodes/`)
- **Cost** — cost visibility (`cost/`)
- **Compliance / Security / Governance** — policy, RBAC, and audit views (`compliance/`,
  `security/`, `governance/`)
- **Architecture / Templates / Tools** — service graph, scaffolding templates, platform tools
  grid (`architecture/`, `templates/`, `tools/`)
- **Settings** — users, routes, certificates, policies

Routes live under `src/app/(dashboard)/`; backing API routes under `src/app/api/`.

## Screenshots

> Placeholder gallery — drop your captures into [`docs/images/`](docs/images/) using the filenames shown ([details & tips](docs/images/README.md)); they render automatically.

| Dashboard | Architecture |
| :---: | :---: |
| ![Dashboard](docs/images/dashboard.png) | ![Architecture](docs/images/architecture.png) |
| _Real-time metrics, ArgoCD apps & alerts_ | _Nodes, namespaces & service graph_ |
| **Security** | **Cost** |
| ![Security](docs/images/security.png) | ![Cost](docs/images/cost.png) |
| _Trivy vulnerability reports_ | _Namespace cost breakdown_ |
| **Governance** | **Catalog** |
| ![Governance](docs/images/governance.png) | ![Catalog](docs/images/catalog.png) |
| _Scorecard, DORA & distribution_ | _Self-service app catalog_ |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router) + React 19 |
| Styling | TailwindCSS 4 + shadcn/ui |
| Data | TanStack Query (server) + Zustand (client) |
| Auth | NextAuth 5 (beta) + Keycloak OIDC |
| Cache | Valkey (ioredis) |
| Secrets | OpenBao Agent Injector |
| Package manager | pnpm (`pnpm@10.27.0`, pinned via `packageManager`) |
| Test | Vitest + Playwright (planned — not yet implemented) |

## Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. For a clean-install secrets bootstrap
(`AUTH_SECRET`, `VALKEY_PASSWORD`, Keycloak/OpenBao/ArgoCD credentials), see
[docs/security-clean-install.md](./docs/security-clean-install.md) and run
`bash scripts/bootstrap-secrets.sh` first.

## Build & Deploy

### Host build

```bash
pnpm build   # next build
pnpm start   # next start
```

A production Docker image can also be built locally with `make build` / `make push` / `make all`
(requires Docker Desktop; pushes to `harbor.local.narwhal.internal`).

### In-cluster Kaniko build (no local Docker required)

The cluster builds and pushes images itself via Kaniko, so a local Docker daemon is never
required for a normal deploy:

```bash
./scripts/kaniko-build.sh
```

This pushes the current source to the in-cluster Gitea, applies the Kaniko `Job` template
(`deploy/kaniko-build-job.yaml`), and waits for the build to push
`harbor.local.narwhal.internal/library/narwhal-portal:latest`. Pass `--skip-push` to reuse
source already pushed to Gitea.

### Live development (Skaffold + HMR)

For iterative in-cluster development with hot reload (no local Docker/Node run needed at all),
see **[docs/local-dev.md](./docs/local-dev.md)** — covers `pnpm run dev:skaffold`,
debugging with the Node inspector, and IntelliJ/VS Code attach.

## Development Commands

```bash
pnpm dev              # local dev server
pnpm build            # production build
pnpm run dev:skaffold # in-cluster HMR dev loop (Skaffold + Kaniko)
pnpm run harbor:setup # one-time Kaniko/Harbor auth secret bootstrap
npx tsc --noEmit      # type check
npx shadcn@latest add {component}  # add a shadcn/ui component
```

## Related Docs

- [docs/local-dev.md](./docs/local-dev.md) — full Skaffold/Kaniko dev workflow, troubleshooting
- [docs/security-clean-install.md](./docs/security-clean-install.md) — clean-install secrets and
  security hardening checklist
- `CLAUDE.md` — architecture, agent harness, and conventions for AI-assisted development
