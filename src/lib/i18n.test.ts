import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { ko, en } from "./i18n"

// portal#62: keeps the i18n dictionary and its call sites honest without a
// build-time i18n-lint tool — scans every src/**/*.{ts,tsx} file for `t(...)`
// call sites and cross-checks the referenced keys against the dictionary, and
// fails on leftover TODO-backed i18n work so drift can't silently reappear.

const SRC_ROOT = path.resolve(__dirname, "..")

// Cost surfaces (src/lib/cost.ts, src/components/catalog/service-cost-tab.tsx)
// are owned by a separate in-flight PR per this task's scope — not fixed here.
// Listed explicitly (not silently skipped) so a `pnpm test` pass doesn't hide
// that the file still carries real, unresolved i18n work.
const KNOWN_OUT_OF_SCOPE_TODOS = new Set(["components/catalog/service-cost-tab.tsx"])

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  }) as unknown as fs.Dirent[]
  const files: string[] = []
  for (const entry of entries) {
    // node's recursive readdirSync gives entry.path (or parentPath) relative to dir root
    const base = (entry as any).parentPath ?? (entry as any).path ?? dir
    if (!entry.isFile()) continue
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue
    files.push(path.join(base, entry.name))
  }
  return files
}

const SOURCE_FILES = walk(SRC_ROOT)

const RE_LITERAL = /\bt\(\s*"([A-Za-z][\w.-]*)"/g
const RE_LOCALE_T = /\bt\(\s*locale\s*,\s*"([A-Za-z][\w.-]*)"/g
const RE_TRANSLATE = /\btranslate\(\s*locale\s*,\s*"([A-Za-z][\w.-]*)"/g
const RE_TODO_I18N = /TODO[^\n]*i18n|i18n[^\n]*TODO/i

describe("i18n dictionary completeness", () => {
  it("ko and en expose identical key sets", () => {
    const koKeys = new Set(Object.keys(ko))
    const enKeys = new Set(Object.keys(en))

    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k))
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k))

    expect(missingInEn, `keys present in ko but missing in en: ${missingInEn.join(", ")}`).toEqual([])
    expect(missingInKo, `keys present in en but missing in ko: ${missingInKo.join(", ")}`).toEqual([])
  })

  it("every statically-referenced t() key exists in the dictionary", () => {
    const dictionaryKeys = new Set(Object.keys(ko))
    const unknown: string[] = []
    let literalMatches = 0
    let localeMatches = 0
    let translateMatches = 0
    let totalTCalls = 0
    let totalTranslateCalls = 0

    for (const file of SOURCE_FILES) {
      const rel = path.relative(SRC_ROOT, file)
      const content = fs.readFileSync(file, "utf8")

      totalTCalls += content.match(/\bt\(/g)?.length ?? 0
      totalTranslateCalls += content.match(/\btranslate\(/g)?.length ?? 0

      for (const re of [RE_LITERAL, RE_LOCALE_T, RE_TRANSLATE]) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(content))) {
          const key = m[1]
          if (re === RE_LITERAL) literalMatches++
          else if (re === RE_LOCALE_T) localeMatches++
          else translateMatches++

          if (!dictionaryKeys.has(key)) unknown.push(`${rel}: "${key}"`)
        }
      }
    }

    // Calls where the key is a variable/template expression (e.g. t(labelKey),
    // t(`category.${cat}` as TranslationKey)) can't be resolved statically and
    // are intentionally skipped — the dictionary values themselves are typed
    // via `Record<TranslationKey, string>`, so a genuinely unknown dynamic key
    // would only fail at the `t()` call's fallback-to-key-string behavior, not
    // at compile time. Skipped call sites in this run:
    const dynamicSkipped = totalTCalls - literalMatches - localeMatches + (totalTranslateCalls - translateMatches)
    expect(dynamicSkipped).toBeGreaterThanOrEqual(0)

    expect(unknown, `t() call sites referencing keys missing from the dictionary:\n${unknown.join("\n")}`).toEqual([])
    // sanity: the scan actually found call sites, so a refactor that silently
    // breaks the walk/regex (e.g. renaming src/) doesn't pass vacuously.
    expect(literalMatches + localeMatches + translateMatches).toBeGreaterThan(500)
  })

  it("has no leftover TODO-backed i18n work outside the documented out-of-scope list", () => {
    const offenders: string[] = []

    for (const file of SOURCE_FILES) {
      const rel = path.relative(SRC_ROOT, file)
      const content = fs.readFileSync(file, "utf8")
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (RE_TODO_I18N.test(lines[i]) && !KNOWN_OUT_OF_SCOPE_TODOS.has(rel)) {
          offenders.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }

    expect(offenders, `unresolved i18n TODO markers:\n${offenders.join("\n")}`).toEqual([])
  })

  it("dictionary values carry no TODO placeholders", () => {
    const offenders: string[] = []
    for (const [key, value] of Object.entries(ko)) {
      if (/TODO/i.test(value)) offenders.push(`ko.${key}`)
    }
    for (const [key, value] of Object.entries(en)) {
      if (/TODO/i.test(value)) offenders.push(`en.${key}`)
    }
    expect(offenders, `dictionary values containing TODO placeholders: ${offenders.join(", ")}`).toEqual([])
  })
})
