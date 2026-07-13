"use client"

import { Moon, Sun } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

type Theme = "light" | "dark"

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light")

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light")
  }, [])

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark"
    setTheme(next)
    document.documentElement.classList.toggle("dark", next === "dark")
    // Write the cookie on the PARENT domain (.local.narwhal.internal) so the
    // Keycloak login/logout theme (different host, same site) follows the
    // portal theme. First expire any legacy host-only cookie — two same-name
    // cookies with different scopes would shadow each other unpredictably.
    // On hosts without a parent domain (localhost dev) fall back to host-only.
    const parent = window.location.hostname.split(".").slice(1).join(".")
    const domainAttr = parent.includes(".") ? `; domain=.${parent}` : ""
    if (domainAttr) document.cookie = "narwhal-theme=; path=/; max-age=0; samesite=lax"
    document.cookie = `narwhal-theme=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax${domainAttr}`
  }, [theme])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
    >
      {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  )
}
