"use client"
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

interface MenuItem {
  href: string
  labelKey: TranslationKey
  roles: UserRole[]
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

  return (
    <nav className="border-b bg-background px-6 py-3 flex items-center justify-between shadow-sm">
      <div className="flex items-center gap-6">
        <Link href="/" className="font-bold text-lg text-foreground">
          Narwhal IDP
        </Link>
        <div className="flex gap-1">
          {menuItems
            .filter((item) => item.roles.includes(role))
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${
                  (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                }`}
              >
                {t(item.labelKey)}
              </Link>
            ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <kbd className="font-sans">⌘K</kbd>
          <span>{t("search.hint")}</span>
        </button>
        <span className="text-sm text-muted-foreground">{session?.user?.name}</span>
        <Badge className={roleColors[role]}>{role}</Badge>
        <LocaleSwitcher />
        <ThemeToggle />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Federated logout: also ends the Keycloak SSO session so the user
            // is not silently logged back in.
            window.location.href = "/api/auth/federated-logout"
          }}
        >
          {t("nav.logout")}
        </Button>
      </div>
    </nav>
  )
}
