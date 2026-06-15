# Narwhal Design System

**Date:** 2026-04-19
**Status:** Authoritative — all UI components must comply
**Supersedes:** §4 of `2026-04-17-dashboard-narwhal-redesign-design.md` (dark-only palette)

## 1. Goals

- **Light mode is the default.** Dark mode is a user toggle, not the baseline.
- **One theme system.** Every component uses the same semantic tokens so switching themes re-colors the entire app without component-level edits.
- **No hardcoded colors.** `#0f172a`, `bg-slate-900`, `text-gray-500` inline is a bug — use semantic tokens.
- **Narwhal brand stays constant across themes.** The mascot's hue never changes; only the surfaces around it do.

## 2. Architecture

### 2.1 Two token layers

**Layer 1 — shadcn semantic tokens** (OKLCH, already present): `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--primary`, `--secondary`, `--muted`, `--border`, `--input`, `--ring`, `--destructive`, `--sidebar-*`, `--chart-*`. These drive all shadcn components and cover 80% of UI needs.

**Layer 2 — Narwhal semantic tokens** (extends shadcn): `--narwhal-hero-bg`, `--narwhal-accent`, `--narwhal-accent-soft`, `--narwhal-body`, `--narwhal-belly`, `--narwhal-detail`, `--narwhal-wave`, `--narwhal-success`, `--narwhal-warning`, `--narwhal-danger`, `--narwhal-text-mono`, `--narwhal-text-muted`. Used by hero, mascot, status chips.

### 2.2 Theme switch

- Default: `<html>` has no class → light.
- Dark: `<html class="dark">` → `.dark { ... }` overrides both layers.
- Toggle persists in cookie `narwhal-theme=light|dark` (SSR-friendly; avoids FOUC).
- System preference respected once (first visit) via `prefers-color-scheme` sniff; subsequent visits honor cookie.

### 2.3 Contract for components

1. **Never** use raw hex / `bg-slate-*` / `text-gray-*` in component code.
2. **Always** use: shadcn utilities (`bg-card`, `text-muted-foreground`, `border-border`) OR Narwhal utilities (`bg-narwhal-hero`, `text-narwhal-accent`).
3. For one-off hues inside SVG or gradients: wrap in `style={{ color: "var(--narwhal-accent)" }}` so theme switches cascade.
4. Mascot SVG fills: keep the existing cyan palette constant across themes (brand identity anchor).

## 3. Color tokens

### 3.1 shadcn tokens — unchanged

Keep current OKLCH values in `:root` (light) and `.dark` as-is; shadcn components already consume these.

### 3.2 Narwhal tokens — light + dark pairs

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--narwhal-hero-bg` | `linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)` | `linear-gradient(135deg, #0f172a 0%, #0e2738 100%)` | Hero zone background |
| `--narwhal-hero-border` | `rgba(6,182,212,0.25)` | `rgba(6,182,212,0.15)` | Hero border |
| `--narwhal-accent` | `#0891b2` (cyan-600) | `#22d3ee` (cyan-400) | Links, metric values, horn highlight |
| `--narwhal-accent-soft` | `rgba(8,145,178,0.1)` | `rgba(34,211,238,0.15)` | Chip/badge backgrounds |
| `--narwhal-wave` | `#06b6d4` (cyan-500) | `#06b6d4` (cyan-500) | Hero wave SVG (constant) |
| `--narwhal-body` | `#0891b2` | `#0891b2` | Mascot body (constant) |
| `--narwhal-belly` | `#67e8f9` | `#67e8f9` | Mascot belly (constant) |
| `--narwhal-detail` | `#0e7490` | `#0e7490` | Mascot outlines (constant) |
| `--narwhal-horn` | `#64748b` (slate-500) | `#f1f5f9` (slate-100) | Mascot tusk — contrasts with surrounding surface |
| `--narwhal-success` | `#16a34a` (green-600) | `#4ade80` (green-400) | Healthy states |
| `--narwhal-warning` | `#ca8a04` (yellow-600) | `#facc15` (yellow-400) | Warning states |
| `--narwhal-danger` | `#dc2626` (red-600) | `#f87171` (red-400) | Critical states |
| `--narwhal-text-mono` | `#475569` (slate-600) | `#cbd5e1` (slate-300) | Metric values, timestamps |

### 3.3 Naming rule

Narwhal tokens use the `--narwhal-*` prefix to avoid collision with shadcn. Tailwind exposure in `globals.css` `@theme` block: `--color-narwhal-accent: var(--narwhal-accent)` → utility `bg-narwhal-accent`.

**Retired tokens** (migrate off): `--surface`, `--surface-raised`, `--border-narwhal`, `--text-primary/secondary/muted`, `--accent-narwhal`, `--accent-bright`, `--success`, `--warning`, `--danger`. Replace with shadcn equivalents (`bg-card`, `border-border`, `text-foreground`, `text-muted-foreground`) or `--narwhal-*` equivalents above. Retired tokens keep aliases for one release to avoid breakage, then deleted.

## 4. Typography

- Font: Pretendard (self-hosted via `next/font/local`; spec previously said Inter — code is source of truth, updated 2026-06-10).
- Scale:
  - `text-2xl font-semibold` — page title (was `font-bold` — soften)
  - `text-lg font-semibold` — section heading
  - `text-sm` — body
  - `text-xs` — labels, timestamps
  - `font-mono text-xs` — metric values, IDs
- **Minimum size is `text-xs` (12px). Arbitrary values below 12px (`text-[10px]`, `text-[11px]`, …) are forbidden** — QA 2026-06-10 found 154 violations and bulk-upgraded them to `text-xs`; do not reintroduce.
- Avoid pairing the smallest scale with `text-muted-foreground` for primary reading content — use `text-sm` for table cells / descriptions that users actually read.
- Use `text-foreground` / `text-muted-foreground` — never `text-gray-*` or `text-slate-*`.

## 5. Spacing & layout

- Page container: `container mx-auto px-6 py-8 max-w-7xl` (already in dashboard layout).
- Card padding: `p-5` standard, `p-4` compact.
- Section gap: `space-y-6`.
- Grid gap: `gap-4`.

## 6. Motion

- Hero wave: 5s idle loop, disabled under `prefers-reduced-motion`.
- Mascot breath: 3s scale 1 ↔ 1.02.
- Transition default: `transition-colors duration-200`.
- Theme switch: avoid cross-fade — instant swap reads better.

## 7. Iconography

- Line icons: `lucide-react` at `w-4 h-4` default.
- Status glyphs: ● (filled circle) + color token; never emoji in status.
- Horn/spiral brand mark: SVG in `src/components/narwhal/narwhal.tsx`; reuse via `<Narwhal size={...} state={...} />`.

## 8. Mascot states — palette implication

Mascot SVG fills don't change by theme. Only the wrapping surface changes. Critical/Warning glow effects use `--narwhal-danger` / `--narwhal-warning` tokens which DO adapt per theme (so glow stays legible on light backgrounds).

## 9. Theme toggle UX

- Location: top-right of `<Nav />`, after locale switcher.
- Control: icon-only button, sun/moon glyph, `aria-label="Toggle theme"`.
- Interaction: click → write cookie → set/remove `.dark` class on `<html>` → re-render.
- SSR: `src/app/layout.tsx` reads the cookie server-side, applies class on `<html>` at render, preventing flash.

## 10. Copy tone (carried from §4.4 of the prior spec)

Unchanged. Metaphor first, fact second. `narwhal.copy.{healthy,warning,critical,loading}` i18n keys.

## 11. Component compliance checklist

For every component added or touched:

- [ ] No hex / `slate-*` / `gray-*` in `style=` or `className=`.
- [ ] Uses shadcn utility OR `narwhal-*` utility for all backgrounds/borders/text.
- [ ] Renders correctly in both themes (visually verify).
- [ ] Respects `prefers-reduced-motion`.
- [ ] Mascot (if present) passes `size` prop rather than hardcoding dimensions.

## 12. Files requiring migration

Identified via `grep -r '#0f172a|#020617|#0e2738|#1e293b|bg-slate|text-slate|bg-gray|text-gray'` on 2026-04-19. Each file's hardcoded colors must be replaced with semantic tokens.

### Phase A/B/C new files (hardcoded dark):
- `src/components/dashboard/hero-zone.tsx` — gradient + border inline.
- `src/components/dashboard/hero-summary.tsx` / `hero-radar.tsx` — text colors.
- `src/components/dashboard/argocd-apps-table.tsx` — card bg + border inline.
- `src/components/dashboard/activity-feed.tsx` — card bg, borders.
- `src/components/dashboard/applications-panel.tsx` / `infrastructure-panel.tsx` — labels.
- `src/components/my-apps/*.tsx` — reuses same dark hex style.
- `src/components/narwhal/narwhal.tsx` — horn stroke color should use `--narwhal-horn`.

### Existing files (hardcoded light):
- `src/app/(dashboard)/catalog/page.tsx` — `text-gray-900`, `text-gray-500`.
- `src/app/(dashboard)/{governance,onboarding,nodes,architecture,tools,settings,templates}/page.tsx` — same pattern.
- `src/components/nav.tsx` — nav link colors.
- `src/components/command-palette.tsx` — `bg-white`, `text-slate-*` hardcoded (see also §13).

## 13. Command palette bugfix

**Symptom:** "K검색" heading overlaps with items.

**Root cause (line 105 of `command-palette.tsx`):** the outer `Command.Group` element receives a className meant for the heading (`text-[10px] uppercase tracking-wider`) but that class applies to the whole group (heading + items). The cmdk library renders the heading via `[cmdk-group-heading]` slot, which inherits the container's font size and leading, crushing the spacing.

**Fix:** move the text-style classes onto the heading slot via the supported selector pattern. cmdk exposes `[cmdk-group-heading]` and `[cmdk-item]` data attributes. Use:

```tsx
<Command.Group
  heading={t("search.pages")}
  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
>
  {items.map(...)}
</Command.Group>
```

Also replace the hardcoded palette dialog surfaces:
- `bg-white` → `bg-popover`
- `border-slate-200` → `border-border`
- `text-slate-700` → `text-popover-foreground`
- `text-slate-400` → `text-muted-foreground`
- `data-[selected=true]:bg-slate-100` → `data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground`

## 14. Templates removal

The Templates feature is not needed for this phase. Remove from nav; mark source files deprecated.

- `src/components/nav.tsx`: delete the `/templates` entry from `menuItems`.
- `src/app/(dashboard)/templates/` directory: add a `README.md` note `deprecated — out of scope as of 2026-04-19` so the next dev knows to delete or revive; do not delete source files yet (easier to revive than rewrite if priorities shift).
- `src/lib/i18n.ts`: the `nav.templates` key may remain (harmless) or be removed; removal preferred to shrink dictionary.

## 15. Migration order

1. Update `globals.css` — add `--narwhal-*` token pairs (light defaults + `.dark` overrides), retire old tokens with aliases.
2. Extend Tailwind `@theme` block to expose new tokens.
3. Add theme toggle: server-side cookie read in `layout.tsx`, toggle button in `nav.tsx`.
4. Refactor Phase A/B/C components to semantic tokens (13 files from §12).
5. Refactor existing pages' hardcoded light tokens to semantic tokens (8+ files).
6. Fix command palette overlap + palette-ize its colors.
7. Remove Templates from nav.
8. Visual QA in both themes across every route.

## 16. Out of scope

- Light theme for the mascot body (stays cyan across themes — brand anchor).
- Density modes (compact/comfortable).
- Per-user custom palettes.
- Light-theme variants of hero wave color (keeps cyan-500 — matches mascot).

## 17. Acceptance

- [ ] Toggling theme on `/` switches hero, widgets, nav, command palette, and existing pages consistently in < 50ms.
- [ ] No element stays "the other theme" when toggled (no orphan white boxes in dark mode or dark boxes in light mode).
- [ ] Command palette heading no longer overlaps items.
- [ ] Templates nav entry is gone.
- [ ] `grep -rn '#0f172a\|bg-slate-\|text-gray-\|bg-gray-'` in `src/` returns zero matches in non-`ui/` component files.
