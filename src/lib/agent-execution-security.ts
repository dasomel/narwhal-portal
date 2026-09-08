import { createHash } from "node:crypto";

export const CANONICALIZATION_ID = "narwhal-json-c14n/v1" as const;
export const NORMALIZED_INVOCATION_VERSION = "v1" as const;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ResolutionArtifactInput {
  resolutionId: string;
  policyVersion: string;
  agentIdentity: string;
  sessionId: string;
  tool: string;
  toolContractVersion: string;
  resolvedTarget: JsonValue;
  normalizedResolvedArguments: JsonValue;
  canonicalizationVersion?: string;
  normalizedInvocationVersion?: string;
}

export interface ResolutionArtifact extends ResolutionArtifactInput {
  canonicalizationVersion: typeof CANONICALIZATION_ID;
  normalizedInvocationVersion: typeof NORMALIZED_INVOCATION_VERSION;
  invocationDigest: string;
}

export interface ApprovalRecord {
  approvalId: string;
  decisionId: string;
  decision: "approved" | "denied" | "expired" | "revoked";
  approver: string;
  invocationDigest: string;
  resolutionId: string;
  canonicalizationVersion: typeof CANONICALIZATION_ID;
  approvedAt: string;
  expiresAt: string;
}

export type ApprovalRevalidationResult =
  | { ok: true; invocationDigest: string }
  | {
      ok: false;
      reason:
        | "approval-not-approved"
        | "approval-expired"
        | "canonicalization-version-mismatch"
        | "resolution-mismatch"
        | "invocation-digest-mismatch";
    };

function assertSupportedCanonicalization(version: string): asserts version is typeof CANONICALIZATION_ID {
  if (version !== CANONICALIZATION_ID) {
    throw new Error(`Unsupported canonicalization version: ${version}`);
  }
}

function jsonScalar(value: string | number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Value cannot be represented as canonical JSON");
  }
  return serialized;
}

function canonicalizeValue(value: JsonValue): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return jsonScalar(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Non-finite numbers are not canonical JSON values");
      }
      if (Object.is(value, -0)) return "0";
      return jsonScalar(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalizeValue).join(",")}]`;
      }
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${jsonScalar(key)}:${canonicalizeValue(value[key])}`)
        .join(",")}}`;
    default:
      throw new Error("Unsupported canonical JSON value");
  }
}

export function canonicalizeJson(
  value: JsonValue,
  canonicalizationVersion: string = CANONICALIZATION_ID,
): string {
  assertSupportedCanonicalization(canonicalizationVersion);
  return canonicalizeValue(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digestEnvelope(input: ResolutionArtifactInput): JsonValue {
  return {
    agentIdentity: input.agentIdentity,
    canonicalizationVersion: input.canonicalizationVersion ?? CANONICALIZATION_ID,
    normalizedInvocationVersion:
      input.normalizedInvocationVersion ?? NORMALIZED_INVOCATION_VERSION,
    normalizedResolvedArguments: input.normalizedResolvedArguments,
    policyVersion: input.policyVersion,
    resolvedTarget: input.resolvedTarget,
    sessionId: input.sessionId,
    tool: input.tool,
    toolContractVersion: input.toolContractVersion,
  };
}

export function computeInvocationDigest(input: ResolutionArtifactInput): string {
  const canonicalizationVersion = input.canonicalizationVersion ?? CANONICALIZATION_ID;
  assertSupportedCanonicalization(canonicalizationVersion);

  const normalizedInvocationVersion =
    input.normalizedInvocationVersion ?? NORMALIZED_INVOCATION_VERSION;
  if (normalizedInvocationVersion !== NORMALIZED_INVOCATION_VERSION) {
    throw new Error(`Unsupported normalized invocation version: ${normalizedInvocationVersion}`);
  }

  return sha256(canonicalizeJson(digestEnvelope(input), canonicalizationVersion));
}

export function createResolutionArtifact(input: ResolutionArtifactInput): ResolutionArtifact {
  const canonicalizationVersion = input.canonicalizationVersion ?? CANONICALIZATION_ID;
  assertSupportedCanonicalization(canonicalizationVersion);

  const normalizedInvocationVersion =
    input.normalizedInvocationVersion ?? NORMALIZED_INVOCATION_VERSION;
  if (normalizedInvocationVersion !== NORMALIZED_INVOCATION_VERSION) {
    throw new Error(`Unsupported normalized invocation version: ${normalizedInvocationVersion}`);
  }

  return {
    ...input,
    canonicalizationVersion,
    normalizedInvocationVersion,
    invocationDigest: computeInvocationDigest({
      ...input,
      canonicalizationVersion,
      normalizedInvocationVersion,
    }),
  };
}

export function revalidateApprovedInvocation(
  approval: ApprovalRecord,
  actual: ResolutionArtifactInput,
  now = new Date(),
): ApprovalRevalidationResult {
  if (approval.decision !== "approved") {
    return { ok: false, reason: "approval-not-approved" };
  }

  if (Date.parse(approval.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "approval-expired" };
  }

  const canonicalizationVersion = actual.canonicalizationVersion ?? CANONICALIZATION_ID;
  if (approval.canonicalizationVersion !== canonicalizationVersion) {
    return { ok: false, reason: "canonicalization-version-mismatch" };
  }

  if (approval.resolutionId !== actual.resolutionId) {
    return { ok: false, reason: "resolution-mismatch" };
  }

  let actualDigest: string;
  try {
    actualDigest = computeInvocationDigest(actual);
  } catch {
    return { ok: false, reason: "canonicalization-version-mismatch" };
  }

  if (approval.invocationDigest !== actualDigest) {
    return { ok: false, reason: "invocation-digest-mismatch" };
  }

  return { ok: true, invocationDigest: actualDigest };
}
