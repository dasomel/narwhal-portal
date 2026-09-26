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

// ---------------------------------------------------------------------------
// t()/translate() call scanner
// ---------------------------------------------------------------------------
// Matches any call to a `t(` or `translate(` identifier — regardless of how
// that identifier was bound (useT()'s return value, a destructured
// `const { t } = useI18n()`-style binding, or the direct `t`/`translate`
// import from ./i18n) — and extracts the key argument when it is a string
// literal or an interpolation-free template literal. An optional leading
// `identifier,` is consumed before the key so the locale-first server call
// shape (`t(locale, "key")`, `translate(userLocale, "key")`) is covered
// without hardcoding the parameter name. The lookbehind before `t`/`translate` means
// this only matches a standalone identifier call (not e.g. `.filter(`),
// verified against this repo's actual `t(`/`translate(` call sites (see the
// fixture tests below) before relying on it for the real scan.
const CALL_RE = /(?<![.\w$])(?:t|translate)\(/g // excludes obj.t( property calls
const ARG_RE =
  /^\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/

interface CallMatch {
  key: string
  dynamic: boolean
}

function extractCalls(content: string): CallMatch[] {
  const out: CallMatch[] = []
  CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CALL_RE.exec(content))) {
    // Look only at what immediately follows the call's opening paren — bounded
    // lookahead keeps this from ever matching across an unrelated later call.
    const rest = content.slice(m.index + m[0].length, m.index + m[0].length + 500)
    const arg = ARG_RE.exec(rest)
    if (!arg) {
      out.push({ key: "", dynamic: true })
      continue
    }
    const isTemplate = arg[3] !== undefined
    const raw = arg[1] ?? arg[2] ?? arg[3] ?? ""
    if (isTemplate && raw.includes("${")) {
      // interpolated template literal (e.g. `category.${cat}`) — dynamic
      out.push({ key: "", dynamic: true })
      continue
    }
    if (!/^[A-Za-z][\w.-]*$/.test(raw)) {
      // not a plausible TranslationKey shape — treat as an unrelated call
      out.push({ key: "", dynamic: true })
      continue
    }
    out.push({ key: raw, dynamic: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// TODO scanner — flags a TODO comment mentioning i18n on the same line, or
// whose very next line does (covers a two-line `// TODO(...)\n// i18n ...`
// comment block). Window is deliberately small: current line + next line.
// ---------------------------------------------------------------------------
function findI18nTodoLines(content: string): number[] {
  const lines = content.split("\n")
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/TODO/i.test(lines[i])) continue
    const next = lines[i + 1] ?? ""
    if (/i18n/i.test(lines[i]) || /i18n/i.test(next)) hits.push(i + 1)
  }
  return hits
}

const SOURCE_FILES = walk(SRC_ROOT)

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
    let staticMatches = 0
    let dynamicMatches = 0

    for (const file of SOURCE_FILES) {
      const rel = path.relative(SRC_ROOT, file)
      const content = fs.readFileSync(file, "utf8")
      for (const call of extractCalls(content)) {
        if (call.dynamic) {
          dynamicMatches++
          continue
        }
        staticMatches++
        if (!dictionaryKeys.has(call.key)) unknown.push(`${rel}: "${call.key}"`)
      }
    }

    expect(unknown, `t() call sites referencing keys missing from the dictionary:\n${unknown.join("\n")}`).toEqual([])
    // sanity: the scan actually found call sites, so a refactor that silently
    // breaks the walk/regex (e.g. renaming src/) doesn't pass vacuously.
    expect(staticMatches).toBeGreaterThan(1000)

    // Pinned baseline (recorded 2026-09-24 against this commit, after
    // generalizing the extractor per code review on #62 to catch
    // destructured/wrapper `t()` bindings and interpolation-free template
    // literals). A genuinely new dynamic-key call site (t(someVar),
    // t(`prefix.${x}`), etc.) bumps this number — update the constant
    // deliberately when that's expected; don't raise it just to silence a
    // failure without checking what changed.
    const BASELINE_DYNAMIC_SKIPPED = 46
    expect(dynamicMatches).toBe(BASELINE_DYNAMIC_SKIPPED)
  })

  it("has no leftover TODO-backed i18n work outside the documented out-of-scope list", () => {
    const offenders: string[] = []

    for (const file of SOURCE_FILES) {
      const rel = path.relative(SRC_ROOT, file)
      if (KNOWN_OUT_OF_SCOPE_TODOS.has(rel)) continue
      const content = fs.readFileSync(file, "utf8")
      for (const lineNo of findI18nTodoLines(content)) {
        offenders.push(`${rel}:${lineNo}`)
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

describe("i18n key scanner (unit, fixture-based)", () => {
  it("extracts a plain literal call", () => {
    expect(extractCalls('t("nav.home")')).toEqual([{ key: "nav.home", dynamic: false }])
  })

  it("ignores property calls like obj.t() and api.translate()", () => {
    expect(extractCalls('obj.t("x.y"); api.translate(locale, "a.b")')).toEqual([])
  })

  it("extracts a call bound via destructuring (const { t } = useI18n())", () => {
    const src = 'const { t } = useI18n()\nconst label = t("scorecard.owner")'
    expect(extractCalls(src)).toEqual([{ key: "scorecard.owner", dynamic: false }])
  })

  it("extracts a call with a params object second argument", () => {
    expect(extractCalls('t("argocd.totalApps", { count: 3 })')).toEqual([
      { key: "argocd.totalApps", dynamic: false },
    ])
  })

  it("extracts a locale-first call regardless of the parameter name", () => {
    expect(extractCalls('translate(userLocale, "time.years", { count: n })')).toEqual([
      { key: "time.years", dynamic: false },
    ])
  })

  it("extracts a multiline call", () => {
    const src = 't(\n  "kubeconfig.download"\n)'
    expect(extractCalls(src)).toEqual([{ key: "kubeconfig.download", dynamic: false }])
  })

  it("extracts an interpolation-free template literal", () => {
    expect(extractCalls("t(`nav.home`)")).toEqual([{ key: "nav.home", dynamic: false }])
  })

  it("treats an interpolated template literal as dynamic, not a key", () => {
    expect(extractCalls("t(`category.${cat}`)")).toEqual([{ key: "", dynamic: true }])
  })

  it("treats a bare identifier argument as dynamic", () => {
    expect(extractCalls("t(labelKey)")).toEqual([{ key: "", dynamic: true }])
  })

  it("mutation check: still flags an unknown key inside a destructured/multiline call", () => {
    const dictionaryKeys = new Set(Object.keys(ko))
    const src = 'const { t } = useI18n()\nconst x = t(\n  "totally.missing.key"\n)'
    const unknown = extractCalls(src).filter((c) => !c.dynamic && !dictionaryKeys.has(c.key))
    expect(unknown).toEqual([{ key: "totally.missing.key", dynamic: false }])
  })

  it("flags a TODO whose i18n mention is on the next comment line", () => {
    const src = "// TODO(wrap-up):\n// i18n keys still needed\nconst x = 1"
    expect(findI18nTodoLines(src)).toEqual([1])
  })

  it("does not flag a TODO unrelated to i18n", () => {
    const src = "// TODO: real values require node-exec integration\nconst x = 1"
    expect(findI18nTodoLines(src)).toEqual([])
  })
})
