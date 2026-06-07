import type { Locale } from "./i18n"

/** Localized string pair. Used for audit description/impact/purpose/reason fields. */
export interface Localized {
  ko: string
  en: string
}

/** Field type that may be a plain string (legacy/Korean only) OR a Localized pair. */
export type MaybeLocalized = Localized | string

/**
 * Picks the locale's value. Handles both plain strings (legacy Korean-only data)
 * and Localized `{ ko, en }` pairs. Falls back to ko then en if requested locale missing.
 */
export function pick(loc: MaybeLocalized | undefined, locale: Locale): string {
  if (!loc) return ""
  if (typeof loc === "string") return loc
  return loc[locale] ?? loc.ko ?? loc.en ?? ""
}
