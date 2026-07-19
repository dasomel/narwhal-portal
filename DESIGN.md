---
version: alpha
name: Narwhal IDP Portal
description: >-
  Design system for the Narwhal Kubernetes IDP management portal.
  RUNTIME SOURCE OF TRUTH is src/app/globals.css (Tailwind v4 @theme +
  :root/.dark). This file mirrors those tokens for humans and agents and is
  linted in CI; it is NOT compiled. Colors below are the LIGHT theme
  (default); dark overrides live in .dark and are described in prose.
colors:
  # shadcn semantic tokens (OKLCH) — light theme
  background: oklch(1 0 0)
  foreground: oklch(0.145 0 0)
  card: oklch(1 0 0)
  card-foreground: oklch(0.145 0 0)
  popover: oklch(1 0 0)
  popover-foreground: oklch(0.145 0 0)
  primary: oklch(0.205 0 0)
  primary-foreground: oklch(0.985 0 0)
  secondary: oklch(0.97 0 0)
  secondary-foreground: oklch(0.205 0 0)
  muted: oklch(0.97 0 0)
  muted-foreground: oklch(0.50 0 0)
  accent: oklch(0.97 0 0)
  accent-foreground: oklch(0.205 0 0)
  destructive: oklch(0.577 0.245 27.325)
  border: oklch(0.922 0 0)
  input: oklch(0.922 0 0)
  ring: oklch(0.708 0 0)
  # Narwhal brand tokens (hex/rgba) — mascot hues are theme-constant
  narwhal-accent: "#0891b2"
  narwhal-accent-soft: rgba(8, 145, 178, 0.1)
  narwhal-wave: "#06b6d4"
  narwhal-body: "#0891b2"
  narwhal-belly: "#67e8f9"
  narwhal-detail: "#0e7490"
  narwhal-horn: "#64748b"
  narwhal-success: "#16a34a"
  narwhal-warning: "#ca8a04"
  narwhal-danger: "#dc2626"
  narwhal-text-mono: "#475569"
  narwhal-hero-bg-solid: "#e0f2fe"
typography:
  h1:
    fontFamily: Pretendard Variable
    fontSize: 1.875rem
    fontWeight: 700
    lineHeight: 2.25rem
  h2:
    fontFamily: Pretendard Variable
    fontSize: 1.5rem
    fontWeight: 600
    lineHeight: 2rem
  h3:
    fontFamily: Pretendard Variable
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.75rem
  body:
    fontFamily: Pretendard Variable
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.25rem
  label:
    fontFamily: Pretendard Variable
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1rem
rounded:
  # Derived in @theme inline from a single --radius: 0.625rem (10px)
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  2xl: 18px
spacing:
  # Tailwind default scale (v4); listed for reference — not custom-overridden
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
  badge-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
---

## Overview

The Narwhal Portal is the management UI for a Kubernetes Internal Developer
Platform. Its design system has four non-negotiable rules, inherited from the
authoritative spec (`docs/superpowers/specs/2026-04-19-narwhal-design-system.md`,
which this file now fronts as the machine-readable token contract):

1. **Light mode is the default.** Dark mode is a user toggle, not the baseline.
2. **One theme system.** Every component uses the same semantic tokens, so a
   theme switch re-colors the whole app with no component-level edits.
3. **No hardcoded colors.** `#0f172a`, `bg-slate-900`, `text-gray-500` inline is
   a bug — use a semantic token.
4. **Narwhal brand stays constant across themes.** The mascot's hue never
   changes; only the surfaces around it do.

**Source of truth:** the tokens above are a mirror of `src/app/globals.css`
(Tailwind v4 CSS-first `@theme` / `:root` / `.dark`). globals.css is what
actually compiles; this DESIGN.md is documentation + a CI lint target. When you
change a token, change it in globals.css **and** here in the same commit — they
are both small single files, kept in sync by hand (DESIGN.md's `export` does not
emit Tailwind v4 `@theme`, so there is no generated pipeline).

## Colors

Two layers:

- **shadcn semantic tokens** (OKLCH) — `background`, `foreground`, `card`,
  `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`,
  `input`, `ring`, plus `sidebar-*` and `chart-1..5` (omitted from the token
  map above for brevity; see globals.css). These drive all shadcn/ui components
  and cover ~80% of the UI.
- **Narwhal brand tokens** (hex/rgba) — `narwhal-accent`, `narwhal-wave`,
  `narwhal-body`, `narwhal-belly`, `narwhal-detail`, `narwhal-horn`,
  `narwhal-success/warning/danger`, `narwhal-text-mono`, and the hero surface
  (`narwhal-hero-bg`, `-solid`, `-border`). Used by the hero, the mascot, and
  status chips.

**Dark theme** (not expressible in this front matter's single-theme model)
overrides both layers in `.dark`: neutrals invert (`background` → `oklch(0.145 0
0)`, `card` → `oklch(0.205 0 0)`), and a few brand hues brighten for contrast
(`narwhal-accent` `#0891b2` → `#22d3ee`, `narwhal-horn` `#64748b` → `#f1f5f9`).
The mascot body/belly/detail/wave hues do **not** change — they are the brand
identity anchor.

`muted-foreground` was deliberately darkened from `oklch(0.556)` to `oklch(0.50)`
(QA 2026-06-10) to give the ~200 small-label + muted combinations comfortable
headroom over the WCAG AA 4.5:1 floor.

## Typography

Single family: **Pretendard Variable**, self-hosted via `next/font/local`
(`src/app/fonts/PretendardVariable.woff2`, weight range 45–920), exposed as
`--font-pretendard` and mapped to both `--font-sans` and `--font-heading`. Sizes
come from Tailwind utilities; the tokens above capture the common heading/body/
label steps.

## Layout & Spacing

Spacing uses the stock Tailwind v4 scale (no custom `--spacing`); the `spacing`
tokens above are a reference subset, not an override. Layout is a sidebar +
content shell (`sidebar-*` token set) with role-gated navigation.

## Elevation & Depth

Depth is expressed with borders and subtle surface shifts rather than heavy
shadows — `card`/`popover` sit one step off `background`, `border` at
`oklch(0.922)` (light) / `oklch(1 0 0 / 10%)` (dark). The hero uses a gradient
surface (`narwhal-hero-bg`) with a translucent brand border.

## Shapes

All corner radii derive from a single `--radius: 0.625rem` via `calc()` in
`@theme inline` (`sm` 0.6×, `md` 0.8×, `lg` 1×, `xl` 1.4×, `2xl` 1.8×, up to
`4xl` 2.6×). Change `--radius` once to reshape the whole app.

## Components

shadcn/ui (`components.json`, style `base-nova`, baseColor `neutral`,
`cssVariables: true`, lucide icons) provides the base components; do not edit
`src/components/ui/` by hand — regenerate via `npx shadcn@latest add`. The
`components` tokens above pin the color/shape contract for the four most
contrast-sensitive elements so the linter can check them.

## Do's and Don'ts

**Do**
- Reference semantic tokens (`bg-card`, `text-muted-foreground`, `bg-primary`).
- Add new colors to `globals.css` and mirror them here in the same commit.
- Keep the mascot hues theme-constant.
- Run `npx @google/design.md lint DESIGN.md` before committing token changes.

**Don't**
- Hardcode hex/`slate-*`/`gray-*` in components.
- Add a token to only one of globals.css / DESIGN.md (drift).
- Change `narwhal-body`/`-belly`/`-detail`/`-wave` per theme.
- Treat this file as the compiled source — globals.css is what ships.
