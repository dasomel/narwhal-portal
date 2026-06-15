"use client"

import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"
import { ArgoCDAppsTable } from "@/components/dashboard/argocd-apps-table"
import { ScopedAlertsList } from "@/components/my-apps/scoped-alerts-list"
import { ScopedDeploysList } from "@/components/my-apps/scoped-deploys-list"
import { MyAppsHero, MyAppsHeroEmpty } from "@/components/my-apps/my-apps-hero"
import { Narwhal } from "@/components/narwhal/narwhal"
import type { MyAppsResponse } from "@/types/my-apps"

function BackToOverviewButton() {
  const t = useT()
  const router = useRouter()

  function handleClick() {
    document.cookie = "preferred-landing=/; path=/; max-age=31536000; SameSite=Lax"
    router.push("/")
  }

  return (
    <button
      onClick={handleClick}
      className="text-[12px] text-narwhal-accent hover:text-narwhal-accent/80 transition-colors"
    >
      ← {t("myApps.backToOverview")}
    </button>
  )
}

export function MyAppsView() {
  const t = useT()

  const { data, isLoading, error } = useQuery<MyAppsResponse>({
    queryKey: ["my-apps"],
    queryFn: () => fetch("/api/my-apps").then((r) => r.json()),
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("myApps.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("myApps.description")}</p>
          </div>
        </div>
        <Card
          className="p-8 flex items-center justify-center"
                  >
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("myApps.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("myApps.description")}</p>
        </div>
        <Card className="p-4">
          <span className="text-sm text-narwhal-danger">{t("common.loadError")}</span>
        </Card>
      </div>
    )
  }

  const hasMapping = data.scope.hasMapping

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("myApps.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("myApps.description")}</p>
        </div>
        <BackToOverviewButton />
      </div>

      {/* Hero zone — pre-fetched data, no second /api/hero call */}
      {hasMapping ? (
        <MyAppsHero hero={data.hero} />
      ) : (
        <MyAppsHeroEmpty />
      )}

      {/* Empty state card when no scope mapping */}
      {!hasMapping && (
        <Card
          className="p-8 flex flex-col items-center gap-4 text-center"
                  >
          <Narwhal state="loading" size={96} />
          <div>
            <div className="text-[16px] font-semibold text-foreground">{t("myApps.empty.title")}</div>
            <div className="text-[13px] text-muted-foreground mt-1">{t("myApps.empty.description")}</div>
          </div>
        </Card>
      )}

      {/* Content sections — only shown when scope is mapped */}
      {hasMapping && (
        <div className="space-y-6">
          {/* Your apps */}
          <section>
            <h2 className="text-[13px] font-semibold text-foreground mb-3">{t("myApps.sections.apps")}</h2>
            <ArgoCDAppsTable apps={data.scopedApps} />
          </section>

          {/* Your alerts */}
          <section>
            <ScopedAlertsList alerts={data.scopedAlerts} />
          </section>

          {/* Recent deploys */}
          <section>
            <ScopedDeploysList events={data.scopedEvents} />
          </section>
        </div>
      )}
    </div>
  )
}
