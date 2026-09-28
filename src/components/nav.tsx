"use client"
import { useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import { LocaleSwitcher } from "@/lib/i18n-client"
import { ThemeToggle } from "@/components/theme-toggle"
import type { UserRole } from "@/lib/auth"
import type { TranslationKey } from "@/lib/i18n"
import { getAppVersion } from "@/lib/app-version"
import { DependencyHealthIndicator } from "@/components/dependency-health-indicator"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

interface MenuItem {
  href: string
  labelKey: TranslationKey
  roles: UserRole[]
}

export function getVisibleNavItemCount(widths: number[], availableWidth: number, moreWidth: number, gap: number) {
  const allWidth = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
  if (allWidth <= availableWidth) return widths.length
  let used = 0
  let count = 0
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width
    if (next + gap + moreWidth > availableWidth) break
    used = next
    count++
  }
  return count
}

export function getOverflowNavItems<T>(items: T[], visibleCount: number) {
  return items.slice(visibleCount)
}

export function NavVersion({ label }: { label: string }) {
  const appVersion = getAppVersion()
  return (
    <span
      aria-label={label}
      className="text-[10px] leading-3 text-muted-foreground"
      title={appVersion.commit}
    >
      {appVersion.display}
    </span>
  )
}

// WO-D16 Role Mapping: UI role 'viewer' maps to OIDC group 'oidc:viewer', which binds to the Kubernetes ClusterRole 'platform-viewer'.
const menuItems: MenuItem[] = [
  { href: "/", labelKey: "nav.home", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/status", labelKey: "nav.status", roles: ["cluster-admin", "developer", "viewer", "guest"] },
  { href: "/my-apps", labelKey: "nav.myApps", roles: ["developer", "cluster-admin"] },
  { href: "/catalog", labelKey: "nav.catalog", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/architecture", labelKey: "nav.architecture", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/tools", labelKey: "nav.tools", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/governance", labelKey: "nav.governance", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/cost", labelKey: "nav.cost", roles: ["cluster-admin", "developer", "viewer"] },
  { href: "/security", labelKey: "nav.security", roles: ["cluster-admin"] },
  { href: "/compliance", labelKey: "nav.compliance", roles: ["cluster-admin"] },
  { href: "/live", labelKey: "nav.live", roles: ["cluster-admin", "developer", "viewer", "guest"] },
  { href: "/settings", labelKey: "nav.settings", roles: ["cluster-admin"] },
  { href: "/onboarding", labelKey: "nav.onboarding", roles: ["cluster-admin", "developer", "viewer"] },
]

export function getVisibleNavItems(role: UserRole) {
  return menuItems.filter((item) => item.roles.includes(role))
}

const roleColors: Record<UserRole, string> = {
  "cluster-admin": "bg-red-500/15 text-red-700 dark:text-red-400",
  developer: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  viewer: "bg-muted text-muted-foreground",
  guest: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
}

export function Nav() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const role = session?.user?.role ?? "guest"
  const t = useT()
  const navRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(menuItems.length)
  const visibleItems = getVisibleNavItems(role)

  useEffect(() => {
    const container = navRef.current
    if (!container) return
    const measure = () => {
      const links = [...container.querySelectorAll<HTMLElement>("[data-nav-link]")]
      const more = container.querySelector<HTMLElement>("[data-nav-more]")
      if (!links.length || !more) return
      const available = container.clientWidth
      const widths = links.map((link) => link.getBoundingClientRect().width)
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0
      const moreWidth = more.getBoundingClientRect().width
      setVisibleCount(getVisibleNavItemCount(widths, available, moreWidth, gap))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    container.querySelectorAll("[data-nav-link]").forEach((link) => observer.observe(link))
    return () => observer.disconnect()
  }, [role, t])

  return (
    <nav className="border-b bg-background px-6 py-3 flex items-center justify-between gap-3 shadow-sm">
      <div className="flex min-w-0 flex-1 items-center gap-6">
        <div className="flex shrink-0 flex-col">
          <Link href="/" className="font-bold text-lg text-foreground">
            Narwhal IDP
          </Link>
          <NavVersion label={t("nav.versionLabel")} />
        </div>
        <div ref={navRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {visibleItems.map((item, index) => (
              <Link
                key={item.href}
                data-nav-link
                href={item.href}
                aria-hidden={index >= visibleCount || undefined}
                tabIndex={index >= visibleCount ? -1 : undefined}
                className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-sm transition-colors ${
                  (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                } ${index >= visibleCount ? "invisible absolute w-max" : ""}`}
              >
                {t(item.labelKey)}
              </Link>
            ))}
          <DropdownMenu>
            <DropdownMenuTrigger data-nav-more aria-label={t("nav.more")} className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${visibleCount >= visibleItems.length ? "invisible absolute w-max" : ""}`}>
              {t("nav.more")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {getOverflowNavItems(visibleItems, visibleCount).map((item) => (
                <DropdownMenuItem key={item.href} render={<Link href={item.href} />}>
                  {t(item.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <DependencyHealthIndicator />
        <button
          onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <kbd className="font-sans">⌘K</kbd>
          <span className="whitespace-nowrap">{t("search.hint")}</span>
        </button>
        <span className="text-sm text-muted-foreground">{session?.user?.name}</span>
        <Badge className={roleColors[role]}>{role}</Badge>
        <LocaleSwitcher />
        <ThemeToggle />
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            // Federated logout: POST request with CSRF verification
            try {
              const res = await fetch("/api/auth/federated-logout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
              })
              const data = await res.json().catch(() => null)
              window.location.href = data?.url || "/login"
            } catch {
              window.location.href = "/login"
            }
          }}
        >
          {t("nav.logout")}
        </Button>
      </div>
    </nav>
  )
}
