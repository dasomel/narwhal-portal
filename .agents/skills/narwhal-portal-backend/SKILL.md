---
name: narwhal-portal-backend
description: Implement Narwhal Portal API routes and infrastructure clients while preserving API shapes, auth/secrets, Valkey cache behavior, and cluster-service contracts. Use for Next.js API routes, Keycloak/ArgoCD/APISIX/Prometheus/Alertmanager/OpenBao integrations, or server-side cache changes.
license: Apache-2.0
compatibility: Requires the Narwhal Portal checkout, pnpm, Next.js 16 dependencies, and access to the companion Narwhal repository when cluster contracts must be verified.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/narwhal-portal
  openforge-maturity: draft
  openforge-version: "1"
---

# Narwhal Portal Backend

## Use When

- Adding/changing `src/app/api/**` routes.
- Adding/changing infrastructure service clients, auth headers, cache behavior, or secret lookup.
- Modifying the server-side shape consumed by Portal UI.

## Do Not Use When

- Only changing page/component behavior -> `narwhal-portal-frontend`.
- Final cross-boundary verification -> `narwhal-portal-qa`.

## Inputs

- API intent and consumer response shape.
- Owning upstream service contract and auth method.
- Cache freshness requirement and failure behavior.

## Workflow

1. Read `AGENTS.md` and the relevant repository-local Next.js 16 API documentation.
2. Verify cluster-owned endpoints, namespaces, service names, secret paths, OIDC/RBAC assumptions against the companion Narwhal source instead of memory. Treat that repository as read-only from Portal work.
3. Define an explicit response interface/shape before implementation when UI consumes the route.
4. Preserve the project's infrastructure-client boundary. Do not make UI components call upstream services directly.
5. Use the existing Valkey cache abstraction: cache read -> upstream fetch on miss -> cache write. Cache failures remain non-fatal only where the existing contract says so.
6. Keep cache keys service/resource scoped and avoid reusing one key for different data shapes.
7. Read runtime secrets through the existing secret abstraction; do not commit credentials or invent a second secret-loading path.
8. Map upstream failures to deliberate HTTP responses without leaking credentials/internal details.
9. Finish with `narwhal-portal-qa` to compare producer/consumer shapes, RBAC/auth, cache keys, and build/runtime evidence.

## Verification

Run the repository's type/build/test checks for the changed server path. When an upstream service contract matters, use integration evidence if available and state when the change is verified only against static/mocked behavior.

## Stop / Escalate When

- Required cluster contract is absent or inconsistent with Portal assumptions.
- The change requires new secret/RBAC/OIDC ownership in the cluster repository.
- A route would bypass current auth/access boundaries or expose sensitive upstream errors.

## References

- `AGENTS.md`
- `src/app/api/`
- existing clients under `src/lib/`
- cache/secret abstractions
- companion Narwhal GitOps/scripts for cluster-owned contracts
