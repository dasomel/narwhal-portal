# Dashboard Narwhal Redesign — Design Spec

**Date:** 2026-04-17
**Status:** Draft for review
**Author:** brainstorming session (dasomell@gmail.com + Claude)

## 1. Summary

Rebuild the IDP Portal dashboard around a Narwhal-branded visual identity (palette + mascot + oceanic copy tone) and restructure information architecture so "what needs your attention right now" is surfaced above the fold. Extend to role-focused (`/my-apps`) and real-time (`/live`) pages without disturbing the main `/` dashboard's stability.

## 2. Goals / Non-goals

**Goals:**
- Give the portal a distinctive, coherent identity (vs. looking like every other K8s dashboard).
- Make the main dashboard answer "is anything wrong?" and "what should I do about it?" within the hero zone.
- Introduce a developer-oriented view (`/my-apps`) and a live-ops view (`/live`) without bloating `/`.
- Keep polling-based `/` stable; isolate SSE to `/live`.

**Non-goals:**
- Multi-cluster support (single cluster only).
- Light theme (dark-first; light comes later).
- Mobile-optimized layout (desktop-first; responsive degrade is OK).
- Architecture page live topology (mentioned, deferred to a later spec).

## 3. Scope

**In scope:**
- Narwhal design system (palette, typography, mascot SVGs + 4 states, copy tone, shared components).
- `/` main dashboard: new hero (B+A hybrid) + two-column split layout.
- `/my-apps` new page: developer-scoped view.
- `/live` new page: SSE-powered activity stream.
- `/public` (optional): minimal read-only status page for guests/viewers.
- Inline actions in hero (sync ArgoCD app, jump to runbook, silence alert).

**Out of scope (separate specs):**
- Live topology on `/architecture`.
- Mobile-first redesign.
- Light theme.
- Multi-tenant / multi-cluster.

## 4. Narwhal Design System

### 4.1 Palette (dark theme)

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-canvas` | `#020617` | Page background |
| `--surface` | `#0f172a` | Card surface |
| `--surface-raised` | `#0e2738` | Hero, elevated surfaces |
| `--border` | `#1e293b` | Dividers, card borders |
| `--accent` | `#06b6d4` | Primary accent (horn, links) |
| `--accent-bright` | `#22d3ee` | Highlights, metric values |
| `--narwhal-body` | `#0891b2` | Mascot body fill |
| `--narwhal-belly` | `#67e8f9` | Mascot underside |
| `--narwhal-detail` | `#0e7490` | Mascot outlines, mouth |
| `--success` | `#4ade80` | Healthy state |
| `--warning` | `#facc15` | Warning state |
| `--danger` | `#f87171` | Critical state |
| `--text-primary` | `#f1f5f9` | Headings, values |
| `--text-secondary` | `#94a3b8` | Body copy |
| `--text-muted` | `#64748b` | Labels, timestamps |

Expose via Tailwind v4 CSS variables in `globals.css`. Preserve shadcn compatibility.

### 4.2 Typography & motion

- Font: Inter (already imported).
- Hero title: 16–18px / 600.
- Body: 13px / 400.
- Mono: 11px (for metric values, timestamps).
- Motion: hero wave SVG 5s loop, mascot idle breath 3s loop, state transitions 300ms ease-out.
- Reduce motion: respect `prefers-reduced-motion: reduce` — disable idle loops, keep 150ms transitions.

### 4.3 Mascot

**Style:** Flat Friendly (rounded body, belly accent, eye highlight, smile curve). See `design-system-lock.html` mockup for reference SVG.

**States:**

| State | Trigger | Visual cues |
|-------|---------|-------------|
| `healthy` | no warning/critical | neutral pose, smile, idle breath |
| `warning` | ≥1 warning alert OR ≥1 OutOfSync/Degraded app | eye raised, `!` over horn, yellow eyebrow hint |
| `critical` | ≥1 critical alert | body tilt, wide eyes, red horn glow, `✕` burst |
| `loading` | initial load OR stale data | eyes closed, reduced opacity, bubble particles |

Implement as a single `<Narwhal state={...} size={...} />` React component in `src/components/narwhal/narwhal.tsx`. Inline SVG, no raster.

### 4.4 Copy tone

Principle: **metaphor in first line, fact in second line**. Never metaphor-only.

| State | Metaphor examples | Fact line example |
|-------|-------------------|-------------------|
| healthy | "All calm in deep water" · "Smooth sailing" · "Nothing to surface" | "6 nodes · 126 pods · 0 incidents" |
| warning | "Shallow ripples" · "Something's bubbling up" | "MemoryPressure on worker-2 · 2 apps drifting" |
| critical | "Deep trouble" · "Emergency surfaced" | "2 critical alerts · 1 app degraded" |
| loading | "Listening to the depths…" · "Surfacing data…" | — |

Copy lives in `i18n.ts` under `narwhal.copy.*` with variants chosen deterministically per session (hash of user + date → index) so it doesn't flicker per-render.

## 5. Main dashboard (`/`)

### 5.1 Hero zone (B+A hybrid)

Hero sits always above the fold. Two render modes:

**Summary mode** (healthy):
- Large narwhal (120px tall) on the left.
- Title: one of `narwhal.copy.healthy`.
- Subtitle: "N nodes · N pods · 0 incidents · synced Nm ago".
- Chip row: `● healthy` + `CPU N%` + `MEM N%` + `Nodes N/N` + `Pods N`.

**Radar mode** (warning or critical):
- Slightly smaller narwhal (100px) on the left.
- Title: "N things need attention" (plain, fact-first in this mode).
- Incident list (max 5, severity-sorted): each row = severity glyph + short description + inline action button.
- If >5, "view all (N) →" link to `/live?filter=incidents`.

**Threshold rules** (mode selection):

```
if criticalAlerts ≥ 1 OR degradedApps ≥ 1:
  mode = radar, mascot = critical
elif warningAlerts ≥ 1 OR outOfSyncApps ≥ 1:
  mode = radar, mascot = warning
else:
  mode = summary, mascot = healthy
```

Data source: aggregate from existing `/api/metrics`, `/api/alerts`, `/api/argocd` via a new server-side `/api/hero` endpoint that does one round-trip and caches 10s in Valkey.

### 5.2 Below hero: two-column split

```
┌────────────── Hero (full width) ──────────────┐
│                                                │
├──────────────────────┬─────────────────────────┤
│ ⎔ INFRASTRUCTURE     │ ◇ APPLICATIONS          │
│                      │                         │
│ Resources 1h (chart) │ ArgoCD Apps (table)     │
│ Nodes (per-node)     │ Recent Deploys          │
├──────────────────────┴─────────────────────────┤
│ ⚡ Activity Feed (alerts + events merged)       │
└────────────────────────────────────────────────┘
```

Responsive: below 1024px viewport, columns stack vertically.

### 5.3 Widget mapping

| Current widget | New home | Change |
|---|---|---|
| `ClusterMetrics` | Absorbed into Hero chip row | Component retired (logic moves to hero) |
| `MetricChartsSection` | Infrastructure column top | Keep component, re-style |
| `NodeMetrics` | Infrastructure column bottom | Keep component, add per-row pressure badge |
| `ArgoCDStatus` | Applications column top | Replace badge-only with clickable apps table; inline `sync` action for OutOfSync/Degraded |
| `AlertsWidget` | Merged into Activity Feed | Silence action moves to detail sheet |
| `EventTimeline` | Merged into Activity Feed | Events + alerts in unified stream with severity chip |

New: `ActivityFeed` component combining alerts + events by timestamp desc.
New: `ArgoCDAppsTable` replacing badge summary.
New: `HeroZone` component reading `/api/hero`.

### 5.4 Inline actions

| Widget | Action | Roles |
|---|---|---|
| Hero radar item (alert) | `investigate →` (opens alert detail sheet) | all |
| Hero radar item (alert) | `silence` | cluster-admin, developer |
| Hero radar item (alert) | `runbook →` (if `annotations.runbook_url`) | all |
| Hero radar item (app drift) | `sync` | cluster-admin, developer |
| ArgoCDAppsTable row | `sync` / `rollback` / `view in ArgoCD` | cluster-admin, developer |
| NodeMetrics row | `cordon` / `drain` | cluster-admin only |
| ActivityFeed item | jump to source (catalog/alertmanager/argocd) | all |

Permission gating: use existing `useSession()` pattern from `alerts-widget.tsx:98` — centralize in `hooks/use-role.ts`.

## 6. `/my-apps` — Developer Dashboard (Phase 2)

**Audience:** users in a developer group (Keycloak).

**Filtering logic:**
1. Session includes Keycloak group claims.
2. Map group → ArgoCD project / namespace prefix via config (`src/lib/role-filter.ts`).
3. Show only apps and events scoped to those namespaces.

**Layout:**
- Same hero shell but narwhal message scoped: "Your apps are calm" / "2 of your apps are drifting".
- Below-hero: single column (no infra section) focused on:
  - Your ArgoCD apps (table).
  - Your recent deploys.
  - Your active alerts.

**Default landing:** if user role is `developer` and they have mapped groups, redirect `/` → `/my-apps` on first login. Overridable via cookie (`preferred-landing`).

**Config schema** (`config/role-filter.json` or env-driven):
```json
{
  "groupMappings": [
    { "group": "platform-team", "namespaces": ["platform-*"], "argocdProjects": ["platform"] },
    { "group": "frontend-team", "namespaces": ["frontend-*"], "argocdProjects": ["apps"] }
  ]
}
```

Fallback when user has no mapping: show "ask your admin to scope your apps" empty state with narwhal in `loading` pose.

## 7. `/live` — Live Feed (Phase 4)

**Purpose:** during incidents, surface events as they happen.

**Layout:**
- Narrow header (just nav + page title, no hero — mascot lives in a small badge).
- Stream column: events flow top-down as they arrive.
- Filter chips at top: `all` / `alerts` / `deploys` / `syncs` / `critical`.
- Connection indicator: green dot = live, yellow = reconnecting, red = disconnected.

**SSE endpoint:** `GET /api/events/stream`

Response: `text/event-stream`.

Event shape (one JSON per SSE `data:` line):
```ts
interface LiveEvent {
  id: string            // UUID
  type: "alert" | "deploy" | "sync" | "node" | "custom"
  severity: "info" | "success" | "warning" | "error"
  timestamp: string     // ISO8601
  title: string
  description: string
  source: "alertmanager" | "argocd" | "kubernetes"
  links?: { label: string; href: string }[]
}
```

**Server implementation:**
- Node.js runtime (not edge — the portal uses `@kubernetes/client-node`).
- Long-lived connection; heartbeat comment every 30s to keep proxies from dropping.
- Backpressure: bounded in-memory ring buffer (1000 events) in Valkey pub/sub.
- Fan-in sources:
  - Alertmanager webhook → ring buffer (configure Alertmanager to post to `/api/events/ingest` with shared secret).
  - ArgoCD webhook → ring buffer.
  - Kubernetes informer (cluster-scoped Event watch) → ring buffer, filtered to `type != "Normal"` or deploy-related.
- Client connects via `EventSource`, receives last 50 events on connect (replay from Valkey), then live.

**Reconnection:**
- `EventSource` auto-reconnects.
- Client sends `Last-Event-ID` header on reconnect; server replays missed events from ring buffer.

**Auth:**
- SSE endpoint requires session cookie.
- Role-aware filtering: `viewer`/`guest` see only public-safe events (e.g., no secret references).

## 8. `/public` — Public Status (optional)

**Scope flag:** ship behind `NEXT_PUBLIC_ENABLE_PUBLIC_STATUS=true`; default off.

**Layout:**
- Single card, no nav bar.
- Large narwhal (healthy/warning/critical based on overall cluster health).
- Text: "Narwhal IDP · All systems operational" / "Degraded: some apps may be unavailable".
- Optional 7-day uptime sparkline.
- No login required.
- Data source: a stripped, rate-limited subset of `/api/hero` exposed at `/api/public/status`.

Guest role handling: `guest` users redirect to `/public` after login.

## 9. API changes

### New endpoints

| Endpoint | Purpose | Cache |
|---|---|---|
| `GET /api/hero` | Aggregated hero data (metrics + alerts + argocd counts + mode decision) | Valkey 10s |
| `GET /api/events/stream` | SSE live event stream | — (long-lived) |
| `POST /api/events/ingest` | Webhook receiver (Alertmanager/ArgoCD) | — |
| `GET /api/my-apps` | Filtered apps/events for current user | Valkey 15s, keyed by user+groups |
| `GET /api/public/status` | Public-safe status summary | Valkey 30s |

### Modified endpoints

| Endpoint | Change |
|---|---|
| `/api/alerts` | Add `severity` filter query param |
| `/api/argocd` | Return per-app records (not just counts): `{ apps: [...], summary: { synced, outOfSync, degraded } }` |
| `/api/events` | Add `since` query param for incremental fetch |

Response shape contracts live in `src/types/api.ts` (new) — consumed directly by frontend components.

## 10. Component inventory

### New (under `src/components/narwhal/`)
- `narwhal.tsx` — mascot SVG component with `state` prop.
- `narwhal-copy.ts` — pure functions for picking copy variants.

### New (under `src/components/dashboard/`)
- `hero-zone.tsx` — the B+A hybrid hero.
- `hero-summary.tsx` — summary-mode content.
- `hero-radar.tsx` — radar-mode content with incident list.
- `argocd-apps-table.tsx` — replaces `argocd-status.tsx`.
- `activity-feed.tsx` — merged alerts + events stream.
- `infrastructure-panel.tsx` — left column container.
- `applications-panel.tsx` — right column container.

### New (under `src/components/live/`)
- `live-stream.tsx` — SSE client.
- `connection-indicator.tsx`.

### Modified
- `src/app/(dashboard)/page.tsx` — rewrite layout.
- `src/app/(dashboard)/layout.tsx` — apply new palette background token.
- `src/components/nav.tsx` — update logo to narwhal mark, tweak for palette.
- `src/components/dashboard/alerts-widget.tsx` — retire (logic moves to `activity-feed.tsx`).
- `src/components/dashboard/argocd-status.tsx` — retire (replaced by `argocd-apps-table.tsx`).
- `src/components/dashboard/event-timeline.tsx` — retire (merged into `activity-feed.tsx`).
- `src/components/dashboard/cluster-metrics.tsx` — retire (absorbed into hero).
- `src/lib/i18n.ts` — add `narwhal.copy.*` and new widget keys (ko + en).
- `src/app/globals.css` — palette tokens.

### New pages
- `src/app/(dashboard)/my-apps/page.tsx`
- `src/app/(dashboard)/live/page.tsx`
- `src/app/public/page.tsx` + `src/app/public/layout.tsx` (no-auth outside `(dashboard)` group)

## 11. Hooks / utilities

- `src/hooks/use-role.ts` — centralized session/role/permissions reader.
- `src/hooks/use-live-stream.ts` — `EventSource` wrapper with reconnect.
- `src/lib/role-filter.ts` — group → namespace/project mapping loader.

## 12. Implementation phases

Spec splits into four deliverable phases; each phase is an independently reviewable unit.

- **Phase A — Foundation** (design system + hero + main dashboard restructure)
  - Palette tokens, `Narwhal` component (4 states), copy i18n additions.
  - `/api/hero` endpoint + threshold logic.
  - `HeroZone` + summary/radar variants.
  - Two-column split, retire old widgets, ship new `ActivityFeed`, `ArgoCDAppsTable`.
  - Inline actions + role gating hook.

- **Phase B — `/my-apps`** (Phase 2 of effectiveness roadmap)
  - `use-role.ts`, `role-filter.ts`, group-mapping config.
  - `/api/my-apps` endpoint.
  - `/my-apps/page.tsx`.
  - Default-landing redirect for developer role.

- **Phase C — `/live`** (Phase 4)
  - `/api/events/stream` SSE handler + Valkey ring buffer.
  - `/api/events/ingest` webhook + Alertmanager/ArgoCD wiring.
  - Kubernetes informer integration.
  - `/live/page.tsx` + `LiveStream` client.

- **Phase D — `/public`** (optional, flagged)
  - `/api/public/status` stripped endpoint.
  - `/public/page.tsx` (no-auth).
  - Guest redirect.

Each phase runs through the project's Agent Team Harness (portal-frontend + portal-backend in parallel, then portal-qa) per `CLAUDE.md`.

## 13. Testing

- Unit: Vitest for `threshold rules`, `copy variant picker`, `role-filter`.
- Component: Vitest + `@testing-library/react` for `Narwhal` states, `HeroZone` modes.
- Contract: response-shape snapshots for new `/api/hero`, `/api/my-apps`, `/api/events/stream` event types.
- QA: `portal-qa` skill cross-checks API shapes vs. frontend types per existing harness.
- Manual: spin up dev server, exercise healthy/warning/critical states by curling Alertmanager-style fixtures.

## 14. Rollout

- Phase A ships behind `NEXT_PUBLIC_NEW_DASHBOARD=true` initially for preview. Old widgets remain buildable until Phase A is validated, then retired in a follow-up cleanup PR.
- Phases B/C/D independently ship once Phase A is in.

## 15. Open questions (for review before Phase A kickoff)

- **Webhook auth for `/api/events/ingest`**: shared secret from OpenBao, or mTLS via ambient mesh? (Default: shared secret injected via OpenBao Agent; confirm.)
- **Valkey ring buffer persistence**: in-memory only (lost on Valkey restart) or AOF-enabled? (Default: in-memory; SSE clients replay from last-event-id buffer only, not historical.)
- **`/my-apps` group mapping**: static config file or CRD? (Default: static config file under `config/role-filter.json`, reloaded on restart.)
- **Guest role**: does it even hit the portal (today it redirects out)? If yes, `/public` is the only page it sees; confirm.

## 16. Deferred (future specs)

- Live topology on `/architecture` using `/api/events/stream`.
- Light theme.
- Mobile-first layout.
- Multi-cluster support.
- Historical incident replay on `/live` (time travel).
