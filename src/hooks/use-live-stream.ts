"use client"

import { useEffect, useRef, useState } from "react"
import type { LiveEvent } from "@/types/live"

export type StreamStatus = "connecting" | "live" | "reconnecting" | "disconnected"

export interface LiveStreamState {
  events: LiveEvent[]
  status: StreamStatus
}

const MAX_EVENTS = 500

export function useLiveStream(): LiveStreamState {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>("connecting")
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    function connect() {
      const es = new EventSource("/api/events/stream")
      esRef.current = es

      es.addEventListener("open", () => {
        setStatus("live")
      })

      es.addEventListener("live", (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as LiveEvent
          setEvents((prev) => {
            const next = [event, ...prev]
            return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next
          })
        } catch {
          // malformed JSON — silently ignore
        }
      })

      es.addEventListener("error", () => {
        if (es.readyState === EventSource.CONNECTING) {
          setStatus("reconnecting")
        } else if (es.readyState === EventSource.CLOSED) {
          setStatus("disconnected")
        }
      })
    }

    connect()

    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  return { events, status }
}
