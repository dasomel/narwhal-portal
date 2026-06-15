"use client"

import { useEffect, useState, useCallback } from "react"
import { Command } from "cmdk"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { useT } from "@/lib/i18n-client"
import { useSession } from "next-auth/react"
import type { CatalogService } from "@/lib/argocd"
import type { UserRole } from "@/lib/auth"

interface SearchItem {
  id: string
  label: string
  group: string
  href: string
  keywords?: string
}

const STATIC_PAGES: SearchItem[] = [
  { id: "dashboard", label: "Dashboard", group: "pages", href: "/", keywords: "home" },
  { id: "tools", label: "Tools", group: "pages", href: "/tools", keywords: "platform" },
  { id: "settings", label: "Settings", group: "pages", href: "/settings", keywords: "admin" },
  { id: "onboarding", label: "Onboarding", group: "pages", href: "/onboarding", keywords: "kubeconfig guide" },
  { id: "catalog", label: "Service Catalog", group: "pages", href: "/catalog", keywords: "services argocd" },
]

const TOOL_ITEMS: SearchItem[] = [
  { id: "t-argocd", label: "ArgoCD", group: "tools", href: "/tools", keywords: "gitops deploy" },
  { id: "t-gitea", label: "Gitea", group: "tools", href: "/tools", keywords: "git source" },
  { id: "t-harbor", label: "Harbor", group: "tools", href: "/tools", keywords: "registry container image" },
  { id: "t-grafana", label: "Grafana", group: "tools", href: "/tools", keywords: "monitoring dashboard" },
  { id: "t-prometheus", label: "Prometheus", group: "tools", href: "/tools", keywords: "metrics" },
  { id: "t-headlamp", label: "Headlamp", group: "tools", href: "/tools", keywords: "kubernetes dashboard" },
  { id: "t-openbao", label: "OpenBao", group: "tools", href: "/tools", keywords: "secrets vault" },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const t = useT()
  const { data: session } = useSession()
  const role = session?.user?.role as UserRole | undefined

  const { data: services } = useQuery<CatalogService[]>({
    queryKey: ["catalog"],
    queryFn: () => fetch("/api/catalog").then((r) => r.json()),
    enabled: open,
    staleTime: 30_000,
  })

  const serviceItems: SearchItem[] = (services ?? []).map((s) => ({
    id: `svc-${s.name}`,
    label: s.name,
    group: "services",
    href: `/catalog/${s.name}`,
    keywords: `${s.namespace} ${s.syncStatus} ${s.healthStatus}`,
  }))

  // Filter settings for non-admin
  const pages = STATIC_PAGES.filter((p) => {
    if (p.id === "settings" && role !== "cluster-admin") return false
    return true
  })

  const allItems = [...pages, ...TOOL_ITEMS, ...serviceItems]

  const toggle = useCallback(() => setOpen((o) => !o), [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        toggle()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  function handleSelect(href: string) {
    setOpen(false)
    router.push(href)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg">
        <Command
          className="rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
          label={t("search.label")}
        >
          <Command.Input
            placeholder={t("search.placeholder")}
            className="w-full px-4 py-3 text-sm border-b border-border outline-none bg-transparent"
          />
          <Command.List className="max-h-[320px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground">
            <Command.Empty className="text-center text-sm text-muted-foreground py-6">
              {t("search.noResults")}
            </Command.Empty>

            <Command.Group heading={t("search.pages")}>
              {pages.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${item.label} ${item.keywords ?? ""}`}
                  onSelect={() => handleSelect(item.href)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                  {item.label}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading={t("search.tools")}>
              {TOOL_ITEMS.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${item.label} ${item.keywords ?? ""}`}
                  onSelect={() => handleSelect(item.href)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-narwhal-accent" />
                  {item.label}
                </Command.Item>
              ))}
            </Command.Group>

            {serviceItems.length > 0 && (
              <Command.Group heading={t("search.services")}>
                {serviceItems.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.label} ${item.keywords ?? ""}`}
                    onSelect={() => handleSelect(item.href)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-narwhal-success" />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          <div className="border-t border-border px-4 py-2 flex justify-end">
            <span className="text-xs text-muted-foreground">ESC {t("search.close")}</span>
          </div>
        </Command>
      </div>
    </div>
  )
}
