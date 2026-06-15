"use client"
import { createContext, useContext, useCallback, useTransition, type ReactNode } from "react"
import { type Locale, type TranslationKey, defaultLocale, t as translate } from "./i18n"

const LocaleContext = createContext<Locale>(defaultLocale)

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}

export function useLocale(): Locale {
  return useContext(LocaleContext)
}

export function useT() {
  const locale = useContext(LocaleContext)
  return useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )
}

export function LocaleSwitcher() {
  const locale = useContext(LocaleContext)
  const [, startTransition] = useTransition()

  function switchLocale(next: Locale) {
    document.cookie = `locale=${next};path=/;max-age=${60 * 60 * 24 * 365}`
    startTransition(() => {
      window.location.reload()
    })
  }

  return (
    <button
      onClick={() => switchLocale(locale === "ko" ? "en" : "ko")}
      className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
    >
      {locale === "ko" ? "EN" : "KO"}
    </button>
  )
}
