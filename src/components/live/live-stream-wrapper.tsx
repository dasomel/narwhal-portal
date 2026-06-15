"use client"

import { useLiveStream } from "@/hooks/use-live-stream"
import { ConnectionIndicator } from "@/components/live/connection-indicator"
import { LiveStream } from "@/components/live/live-stream"
import type { FilterKey } from "@/components/live/filter-chips"

interface LiveStreamWrapperProps {
  initialFilter?: FilterKey
}

export function LiveStreamWrapper({ initialFilter = "all" }: LiveStreamWrapperProps) {
  const { events, status } = useLiveStream()

  return (
    <>
      <div className="flex justify-end">
        <ConnectionIndicator status={status} />
      </div>
      <LiveStream events={events} initialFilter={initialFilter} />
    </>
  )
}
