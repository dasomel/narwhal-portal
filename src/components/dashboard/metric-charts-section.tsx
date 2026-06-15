"use client"

import { useState } from "react"
import { MetricChart } from "./metric-chart"

const RANGES = [
  { label: "1h", minutes: 60 },
  { label: "3h", minutes: 180 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
]

export function MetricChartsSection() {
  const [minutes, setMinutes] = useState(60)

  return (
    <div className="space-y-3">
      <div className="flex gap-1 justify-end">
        {RANGES.map((r) => (
          <button
            key={r.label}
            onClick={() => setMinutes(r.minutes)}
            className={`text-xs px-2.5 py-1 rounded border transition-colors ${
              minutes === r.minutes
                ? "bg-narwhal-accent text-white border-narwhal-accent"
                : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <MetricChart metric="cpu" minutes={minutes} />
        <MetricChart metric="memory" minutes={minutes} />
        <MetricChart metric="pods" minutes={minutes} />
      </div>
    </div>
  )
}
