"use client"

import { useMutation } from "@tanstack/react-query"
import type { ApplyTarget } from "@/lib/tuning-commands"

export interface TuningApprovalEnvelope {
  approvalId: string
  resolutionId: string
  invocationDigest: string
  canonicalizationVersion: string
  approvedAt: string
  expiresAt: string
}

export interface ResolvedTuningInvocation {
  resolutionId: string
  tool: string
  toolContractVersion: string
  target: unknown
  arguments: unknown
  canonicalizationVersion: string
  normalizedInvocationVersion: string
  invocationDigest: string
}

export interface TuningApprovalResponse {
  approval: TuningApprovalEnvelope
  resolvedInvocation: ResolvedTuningInvocation
  error?: string
}

interface ApplyResponse {
  ok: boolean
  jobName: string
  logs: string
  appliedBy?: string
  appliedAt?: string
  evidence?: {
    approvalId: string
    resolutionId: string
    invocationDigest: string
    canonicalizationVersion: string
    normalizedInvocationVersion: string
  }
  error?: string
  reason?: string
}

export async function resolveTuningApproval(
  nodeName: string,
  items: ApplyTarget[],
): Promise<TuningApprovalResponse> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(nodeName)}/tuning/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  })
  const json = (await res.json().catch(() => ({}))) as TuningApprovalResponse
  if (!res.ok || !json.approval || !json.resolvedInvocation) {
    throw new Error(json.error ?? `Approval resolution failed: HTTP ${res.status}`)
  }
  return json
}

async function applyTuning(
  nodeName: string,
  items: ApplyTarget[],
  approval: TuningApprovalEnvelope,
): Promise<ApplyResponse> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(nodeName)}/tuning/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, approval }),
  })
  const json = (await res.json().catch(() => ({}))) as ApplyResponse
  if (!res.ok && !json.error) {
    return { ok: false, jobName: "", logs: "", error: `HTTP ${res.status}` }
  }
  return json
}

export function useTuningApply(nodeName: string) {
  return useMutation({
    mutationFn: ({ items, approval }: { items: ApplyTarget[]; approval: TuningApprovalEnvelope }) =>
      applyTuning(nodeName, items, approval),
  })
}
