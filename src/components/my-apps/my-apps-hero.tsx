"use client"

import { Narwhal } from "@/components/narwhal/narwhal"
import { HeroZoneFromData } from "@/components/dashboard/hero-zone"
import { useT } from "@/lib/i18n-client"
import type { MyAppsResponse } from "@/types/my-apps"
import type { HeroResponse } from "@/types/api"

interface MyAppsHeroProps {
  hero: MyAppsResponse["hero"]
}

/** Adapts the MyAppsResponse hero payload into HeroResponse shape for HeroZoneFromData. */
export function MyAppsHero({ hero }: MyAppsHeroProps) {
  const heroResponse: HeroResponse = {
    mode: hero.mode,
    mascot: hero.mascot,
    // summary is not in the my-apps hero payload — provide safe defaults
    summary: {
      nodes: { ready: 0, total: 0 },
      pods: { running: 0, total: 0 },
      cpu: 0,
      memory: 0,
      syncedAgo: null,
    },
    incidents: hero.incidents,
    incidentTotalCount: hero.incidents.length,
    copy: {
      title: hero.title,
      subtitle: hero.subtitle,
    },
    generatedAt: new Date().toISOString(),
  }

  return <HeroZoneFromData data={heroResponse} />
}

interface MyAppsHeroEmptyProps {
  t: (key: string) => string
}

export function MyAppsHeroEmpty() {
  const t = useT()
  return (
    <div
      className="relative overflow-hidden rounded-lg border px-5 py-5 flex items-center gap-4"
      style={{
        background: "var(--narwhal-hero-bg)",
        borderColor: "var(--narwhal-hero-border)",
      }}
    >
      <Narwhal state="loading" size={96} />
      <div>
        <div className="text-[17px] font-semibold text-foreground">{t("myApps.empty.title")}</div>
        <div className="text-[13px] text-muted-foreground mt-1">{t("myApps.empty.description")}</div>
      </div>
    </div>
  )
}
