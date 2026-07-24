#!/usr/bin/env bash
# =============================================================================
# harness-rules.sh — make the countable CLAUDE.md "Critical Rules" actually block.
#
# These rules were prose only, and the codebase already violates them (i18n debt
# is even acknowledged in-code, see the TODO at the top of service-map-view.tsx).
# Cleaning all of it up is a separate project, so this is a RATCHET: the current
# counts are recorded as baselines and CI fails when a count goes UP. Going down
# is fine — lower the baseline in the same commit that pays the debt off.
#
# Usage: scripts/harness-rules.sh      (exit 1 = a new violation was added)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# --- baselines (2026-07-25) --------------------------------------------------
BASE_INLINE_STYLE=47
BASE_HARDCODED_KO=48

fail=0

check() {
  local name=$1 cur=$2 base=$3
  if [ "$cur" -gt "$base" ]; then
    printf 'FAIL  %-34s %s (baseline %s) — new violations added\n' "$name" "$cur" "$base"
    fail=1
  elif [ "$cur" -lt "$base" ]; then
    printf 'OK    %-34s %s (baseline %s) — improved; lower the baseline here\n' "$name" "$cur" "$base"
  else
    printf 'OK    %-34s %s\n' "$name" "$cur"
  fi
}

# Tailwind-first: inline styles are allowed only for runtime-computed values
# (a colour from data, a width from a percentage). Static ones belong in classes.
inline_style=$(grep -ro 'style={{' src --include='*.tsx' | wc -l | tr -d ' ')

# i18n: UI text goes through src/lib/i18n.ts. Korean in comments/JSDoc is fine,
# so comment-leading lines are excluded.
hardcoded_ko=$(grep -rn '[가-힣]' src --include='*.tsx' 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+: *(//|\*|/\*)' \
  | grep -v 'i18n' | wc -l | tr -d ' ' || true)

check "inline styles (style={{)" "$inline_style" "$BASE_INLINE_STYLE"
check "hardcoded Korean (non-comment)" "$hardcoded_ko" "$BASE_HARDCODED_KO"

# Not counted here: "don't hand-edit src/components/ui/". Adding a component via
# `npx shadcn@latest add` legitimately writes to that directory, so a diff-based
# check cannot tell a regeneration from a hand-edit. It stays a review-time rule.

exit "$fail"
