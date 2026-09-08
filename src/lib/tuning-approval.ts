import { randomUUID } from "node:crypto"

import {
  CANONICALIZATION_ID,
  createResolutionArtifact,
  revalidateApprovedInvocation,
  type ApprovalRecord,
  type ResolutionArtifact,
} from "@/lib/agent-execution-security"
import { buildJobScript, type ApplyTarget } from "@/lib/tuning-commands"
import { getIdempotencyStore } from "@/lib/idempotency"

export const TUNING_TOOL = "node.tuning.apply" as const
export const TUNING_TOOL_CONTRACT_VERSION = "v1" as const
export const TUNING_POLICY_VERSION = "portal-agent-security/v1" as const
export const APPROVAL_TTL_MS = 2 * 60_000
export const APPROVAL_REPLAY_TTL_SECONDS = 5 * 60

export interface TuningApprovalEnvelope {
  approvalId: string
  resolutionId: string
  invocationDigest: string
  canonicalizationVersion: typeof CANONICALIZATION_ID
  approvedAt: string
  expiresAt: string
}

export function validateTuningItems(items: unknown): ApplyTarget[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("items required")
  if (items.length > 50) throw new Error("too many items (max 50)")
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error("invalid item")
  }
  const targets = items as ApplyTarget[]
  // This is the authoritative per-kind allowlist validation. The returned targets
  // are the same concrete values bound into the approval digest and later executed.
  buildJobScript(targets)
  return targets
}

export function createTuningResolution(input: {
  nodeName: string
  items: ApplyTarget[]
  actor: string
  resolutionId?: string
}): ResolutionArtifact {
  return createResolutionArtifact({
    resolutionId: input.resolutionId ?? randomUUID(),
    policyVersion: TUNING_POLICY_VERSION,
    agentIdentity: "portal:auto-fix",
    sessionId: `operator:${input.actor}`,
    tool: TUNING_TOOL,
    toolContractVersion: TUNING_TOOL_CONTRACT_VERSION,
    resolvedTarget: { kind: "Node", name: input.nodeName },
    normalizedResolvedArguments: { items: input.items },
  })
}

export function issueTuningApproval(input: {
  nodeName: string
  items: ApplyTarget[]
  actor: string
  now?: Date
}): { artifact: ResolutionArtifact; approval: TuningApprovalEnvelope } {
  const now = input.now ?? new Date()
  const artifact = createTuningResolution(input)
  return {
    artifact,
    approval: {
      approvalId: randomUUID(),
      resolutionId: artifact.resolutionId,
      invocationDigest: artifact.invocationDigest,
      canonicalizationVersion: artifact.canonicalizationVersion,
      approvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    },
  }
}

export async function consumeTuningApproval(input: {
  envelope: TuningApprovalEnvelope
  nodeName: string
  items: ApplyTarget[]
  actor: string
  now?: Date
}): Promise<{ ok: true; artifact: ResolutionArtifact } | { ok: false; reason: string }> {
  const artifact = createTuningResolution({
    nodeName: input.nodeName,
    items: input.items,
    actor: input.actor,
    resolutionId: input.envelope.resolutionId,
  })
  const record: ApprovalRecord = {
    ...input.envelope,
    decisionId: input.envelope.approvalId,
    decision: "approved",
    approver: input.actor,
  }
  const validation = revalidateApprovedInvocation(record, artifact, input.now)
  if (!validation.ok) return validation

  const replay = await getIdempotencyStore().claim(
    `agent-approval:${input.envelope.approvalId}`,
    artifact.invocationDigest,
    APPROVAL_REPLAY_TTL_SECONDS,
  )
  if (replay !== null) return { ok: false, reason: "approval-replayed" }

  return { ok: true, artifact }
}
