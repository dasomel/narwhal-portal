"use client"

import { useMutation } from "@tanstack/react-query"
import type { ApplyTarget } from "@/lib/tuning-commands"

interface ApplyResponse {
  ok: boolean
  jobName: string
  logs: string
  appliedBy?: string
  appliedAt?: string
  error?: string
}

async function applyTuning(nodeName: string, items: ApplyTarget[]): Promise<ApplyResponse> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(nodeName)}/tuning/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
  const json = (await res.json().catch(() => ({}))) as ApplyResponse
  if (!res.ok && !json.error) {
    return { ok: false, jobName: "", logs: "", error: `HTTP ${res.status}` }
  }
  return json
}

export function useTuningApply(nodeName: string) {
  return useMutation({
    mutationFn: (items: ApplyTarget[]) => applyTuning(nodeName, items),
  })
}
