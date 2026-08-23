import { namespaceVisible, type EffectiveScope } from "./scope"

export interface SilenceMatcher {
  name: string
  value: string
  isRegex: boolean
}

export type SilenceScopeVerdict = { ok: true } | { ok: false; status: 400 | 403; message: string }

// portal#34: a regex matcher whose pattern, once anchored, matches any string — the
// exact shape that lets a broad matcher select alerts outside the caller's intended
// target. Anchoring first so ".*foo" (narrower than it looks unanchored) isn't
// mistaken for a catch-all.
const CATCH_ALL_REGEX_RE = /^(\.\*|\.\+|\(\.\*\)|\(\.\+\))+$/

/**
 * portal#34: resolves the matcher set's target namespace and rejects anything a
 * non-admin isn't authorized to silence. Takes an already-resolved `scope`
 * (src/lib/scope.ts's getEffectiveScope) rather than raw groups/teams — same shape
 * as isEventFiltered/assertAppAccessible, and keeps this pure/synchronous-shaped
 * for direct unit testing with a fake scope.
 *
 * - Any `isRegex` matcher matching a catch-all pattern is rejected outright —
 *   regardless of role, a silence that matches every alert value on some label is
 *   almost never the intent and is exactly the "broad matcher" risk this issue flags.
 * - cluster-admin may silence with or without a namespace matcher (global allowed).
 * - Everyone else MUST supply an exact-match (non-regex) `namespace` matcher whose
 *   value is in their visible scope — a namespace-less/global silence, or a regex
 *   namespace matcher that could span namespaces, is elevated-authorization-only.
 */
export function checkSilenceScope(matchers: SilenceMatcher[], role: string, scope: EffectiveScope): SilenceScopeVerdict {
  for (const m of matchers) {
    if (m.isRegex && CATCH_ALL_REGEX_RE.test(m.value.trim())) {
      return { ok: false, status: 400, message: `matcher '${m.name}' is a catch-all regex — narrow it` }
    }
  }

  if (role === "cluster-admin") return { ok: true }

  const nsMatcher = matchers.find((m) => m.name === "namespace")
  if (!nsMatcher) {
    return { ok: false, status: 403, message: "a namespace-less (global) silence requires cluster-admin" }
  }
  if (nsMatcher.isRegex) {
    return { ok: false, status: 403, message: "the namespace matcher must be an exact match for non-admin roles" }
  }

  if (!scope.hasMapping || !namespaceVisible(nsMatcher.value, scope)) {
    return { ok: false, status: 403, message: `not authorized for namespace '${nsMatcher.value}'` }
  }
  return { ok: true }
}
