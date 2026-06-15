"use client"

import { useT } from "@/lib/i18n-client"

export type FilterKey = "all" | "alerts" | "deploys" | "syncs" | "critical"

const FILTERS: FilterKey[] = ["all", "alerts", "deploys", "syncs", "critical"]

interface FilterChipsProps {
  selected: FilterKey
  onChange: (key: FilterKey) => void
}

export function FilterChips({ selected, onChange }: FilterChipsProps) {
  const t = useT()

  return (
    <div className="flex flex-wrap gap-2">
      {FILTERS.map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors border ${
            selected === key
              ? "bg-narwhal-accent text-white border-narwhal-accent"
              : "bg-card text-muted-foreground border-border hover:border-border/80 hover:text-foreground"
          }`}
        >
          {t(`live.filter.${key}` as Parameters<typeof t>[0])}
        </button>
      ))}
    </div>
  )
}
