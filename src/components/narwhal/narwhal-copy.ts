import type { MascotState } from "@/types/api"
import { t } from "@/lib/i18n"
import type { Locale } from "@/lib/i18n"

const VARIANT_COUNTS: Record<MascotState, number> = {
  healthy: 3,
  warning: 3,
  critical: 3,
  loading: 2,
}

/**
 * Deterministically pick a copy title based on state + seed string.
 * Uses a simple djb2-style hash so the result is stable per session seed
 * (e.g. userId + date) and never flickers per-render.
 */
function hashSeed(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) {
    h = (h * 33) ^ seed.charCodeAt(i)
  }
  return Math.abs(h)
}

export function pickCopy(
  state: MascotState,
  seed: string,
  locale: Locale = "ko",
): { title: string } {
  const count = VARIANT_COUNTS[state]
  const idx = hashSeed(seed) % count
  const key = `narwhal.copy.${state}.${idx}` as Parameters<typeof t>[1]
  return { title: t(locale, key) }
}
