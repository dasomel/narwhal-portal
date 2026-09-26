// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Flat ESLint config. eslint-config-next@16.3.1 ships native flat-config arrays
// (no FlatCompat/legacy shim needed) matching the locked `next` version.

import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "public/**", "next-env.d.ts", "src/generated/**"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // 18 hits / 12 pre-existing files (never linted before this gate). Fixing all of
      // them is a real typing pass, out of scope for adding the lint gate itself.
      "@typescript-eslint/no-explicit-any": "warn",
      // react-hooks v7's purity/set-state-in-effect/refs rules are NOT downgraded here
      // wholesale — each entry below lists its actual (small) hit count. They stay warn
      // because fixing them changes effect/render *timing* in production components with
      // no existing test coverage to prove equivalence (AGENTS.md treats that as a Class B
      // behavior change needing its own acceptance criteria, not a lint-gate side effect).
      //
      // react-hooks/purity: 3 hits / 3 files — `Date.now()` read directly in a
      // "relative time" render (argocd-apps-table.tsx, scoped-alerts-list.tsx,
      // scoped-deploys-list.tsx). Real fix needs a ticking clock via useState/useEffect.
      "react-hooks/purity": "warn",
      // react-hooks/set-state-in-effect: 4 hits / 3 files — theme-toggle.tsx (hydrate
      // theme from DOM on mount), resource-detail-drawer.tsx (restore pod selection on
      // open), service-map-view.tsx x2 (reset live flows / seed namespace options).
      // Each needs its own derived-state-vs-effect redesign.
      "react-hooks/set-state-in-effect": "warn",
      // react-hooks/refs: 1 hit / 1 file (service-map-view.tsx) — reads a `useRef`-backed
      // saved-positions map during render (a "lazy ref init" pattern: `if (ref.current ===
      // null) ref.current = load()`). Restructuring the loop shape (map vs for) does not
      // satisfy the rule — it flags the ref read itself, not the callback. The real fix is
      // replacing the ref with useState/useMemo, which changes reactivity semantics and
      // needs its own verification; out of scope for adding the lint gate.
      "react-hooks/refs": "warn",
    },
  },
]

export default eslintConfig
