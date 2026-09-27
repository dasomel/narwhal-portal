"use client"

import { useQuery } from "@tanstack/react-query"
import { Narwhal } from "@/components/narwhal/narwhal"
import { HeroSummary } from "./hero-summary"
import { HeroRadar } from "./hero-radar"
import type { HeroResponse } from "@/types/api"
import { DataState } from "@/components/ui/data-state"

// Wave SVG path from hero-content.html mockup
function HeroWave() {
  return (
    <svg
      viewBox="0 0 400 16"
      preserveAspectRatio="none"
      className="absolute bottom-0 left-0 w-full h-4 opacity-35"
      aria-hidden="true"
    >
      <path d="M0,8 Q50,0 100,8 T200,8 T300,8 T400,8 L400,16 L0,16 Z" fill="var(--narwhal-wave)" />
    </svg>
  )
}

interface HeroZoneFromDataProps {
  data: HeroResponse
}

/** Renders HeroZone with pre-fetched data — no internal fetch. */
export function HeroZoneFromData({ data }: HeroZoneFromDataProps) {
  return (
    <div
      className="relative overflow-hidden rounded-lg border px-5 py-5"
      style={{
        background: "var(--narwhal-hero-bg)",
        borderColor: "var(--narwhal-hero-border)",
      }}
    >
      <HeroWave />
      {data.mode === "summary" ? <HeroSummary data={data} /> : <HeroRadar data={data} />}
    </div>
  )
}

export function HeroZone() {
  const { data, isLoading, isError, refetch } = useQuery<HeroResponse>({
    queryKey: ["hero"],
    queryFn: () => fetch("/api/hero").then((r) => r.json()),
    refetchInterval: 15_000,
  })

  return (
    <div
      className="relative overflow-hidden rounded-lg border px-5 py-5"
      style={{
        background: "var(--narwhal-hero-bg)",
        borderColor: "var(--narwhal-hero-border)",
      }}
    >
      <HeroWave />

      {isLoading && !data ? (
        <div className="flex items-center gap-4">
          <Narwhal state="loading" size={120} />
          <DataState state="loading" onRetry={() => { void refetch() }} />
        </div>
      ) : !data ? (
        <DataState state={isError ? "unavailable" : "loading"} onRetry={() => { void refetch() }} />
      ) : (
        <>
          {isError && <div className="mb-3"><DataState state="stale" onRetry={() => { void refetch() }} /></div>}
          {data.mode === "summary" ? (
        <HeroSummary data={data} />
      ) : (
        <HeroRadar data={data} />
          )}
        </>
      )}
    </div>
  )
}
