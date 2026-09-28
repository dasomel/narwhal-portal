# Governance operational events API

`GET /api/governance/events` returns Kubernetes Events as operational signals, not authoritative audit evidence. It requires `cluster-admin` and returns `{ items, truncated, evidenceKind, freshness }`; `truncated` reports when the bounded Kubernetes list reached its page cap.

`GET /api/governance/audit` remains available for compatibility and continues to return the same bare array. It is deprecated and sets `Deprecation: @1790553600` (RFC 9745 date, 2026-09-28), `X-Truncated: true|false`, and `Link: </api/governance/events>; rel="successor-version"`. New clients should use `/api/governance/events`.

Neither response represents Kubernetes Audit records or includes a user actor. Event producer identity is exposed only as `reportingComponent`.
