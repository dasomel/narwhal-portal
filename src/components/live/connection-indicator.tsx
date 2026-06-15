"use client"

import { useT } from "@/lib/i18n-client"
import type { StreamStatus } from "@/hooks/use-live-stream"

interface ConnectionIndicatorProps {
  status: StreamStatus
}

const config: Record<StreamStatus, { dot: string; label: string; pill: string }> = {
  live: {
    dot: "bg-narwhal-success",
    label: "live.status.live",
    pill: "bg-narwhal-success/15 text-narwhal-success border-narwhal-success/30",
  },
  reconnecting: {
    dot: "bg-narwhal-warning",
    label: "live.status.reconnecting",
    pill: "bg-narwhal-warning/15 text-narwhal-warning border-narwhal-warning/30",
  },
  disconnected: {
    dot: "bg-narwhal-danger",
    label: "live.status.disconnected",
    pill: "bg-narwhal-danger/15 text-narwhal-danger border-narwhal-danger/30",
  },
  connecting: {
    dot: "bg-muted-foreground/50",
    label: "live.status.connecting",
    pill: "bg-muted text-muted-foreground border-border",
  },
}

export function ConnectionIndicator({ status }: ConnectionIndicatorProps) {
  const t = useT()
  const { dot, label, pill } = config[status]

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${pill}`}
    >
      <span className={`w-2 h-2 rounded-full ${dot} ${status === "live" ? "animate-pulse" : ""}`} />
      {t(label as Parameters<typeof t>[0])}
    </span>
  )
}
