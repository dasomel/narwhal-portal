import { describe, expect, it } from "vitest";

import {
  CANONICALIZATION_ID,
  canonicalizeJson,
  computeInvocationDigest,
  createResolutionArtifact,
  revalidateApprovedInvocation,
  type ApprovalRecord,
  type ResolutionArtifact,
} from "./agent-execution-security";

function resolution(): ResolutionArtifact {
  return createResolutionArtifact({
    resolutionId: "res-1",
    policyVersion: "policy-v3",
    agentIdentity: "agent:narwhal",
    sessionId: "session-1",
    tool: "kubernetes.patch",
    toolContractVersion: "v2",
    resolvedTarget: {
      cluster: "prod-a",
      namespace: "payments",
      resource: "deployment/api",
    },
    normalizedResolvedArguments: {
      replicas: 3,
      strategy: "RollingUpdate",
    },
  });
}

function approval(artifact: ResolutionArtifact): ApprovalRecord {
  return {
    approvalId: "approval-1",
    decisionId: "decision-1",
    decision: "approved",
    approver: "user:operator",
    invocationDigest: artifact.invocationDigest,
    resolutionId: artifact.resolutionId,
    canonicalizationVersion: artifact.canonicalizationVersion,
    approvedAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("canonical invocation binding", () => {
  it("canonicalizes object keys deterministically", () => {
    expect(canonicalizeJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
  });

  it("produces the same digest for semantically identical key ordering", () => {
    const first = resolution();
    const second = createResolutionArtifact({
      ...first,
      resolvedTarget: {
        resource: "deployment/api",
        namespace: "payments",
        cluster: "prod-a",
      },
      normalizedResolvedArguments: {
        strategy: "RollingUpdate",
        replicas: 3,
      },
    });

    expect(second.invocationDigest).toBe(first.invocationDigest);
  });

  it("accepts the exact approved invocation", () => {
    const artifact = resolution();
    expect(
      revalidateApprovedInvocation(approval(artifact), artifact, new Date("2026-09-08T12:00:00.000Z")),
    ).toEqual({ ok: true, invocationDigest: artifact.invocationDigest });
  });

  it("rejects argument mutation after approval", () => {
    const artifact = resolution();
    expect(
      revalidateApprovedInvocation(
        approval(artifact),
        { ...artifact, normalizedResolvedArguments: { replicas: 9, strategy: "RollingUpdate" } },
        new Date("2026-09-08T12:00:00.000Z"),
      ),
    ).toEqual({ ok: false, reason: "invocation-digest-mismatch" });
  });

  it("rejects target mutation after approval", () => {
    const artifact = resolution();
    expect(
      revalidateApprovedInvocation(
        approval(artifact),
        {
          ...artifact,
          resolvedTarget: { cluster: "prod-b", namespace: "payments", resource: "deployment/api" },
        },
        new Date("2026-09-08T12:00:00.000Z"),
      ),
    ).toEqual({ ok: false, reason: "invocation-digest-mismatch" });
  });

  it("rejects expired approvals before execution", () => {
    const artifact = resolution();
    expect(
      revalidateApprovedInvocation(approval(artifact), artifact, new Date("2026-09-10T00:00:00.000Z")),
    ).toEqual({ ok: false, reason: "approval-expired" });
  });

  it("fails closed for an unsupported canonicalization version", () => {
    const artifact = resolution();
    expect(() =>
      computeInvocationDigest({ ...artifact, canonicalizationVersion: "narwhal-json-c14n/v999" }),
    ).toThrow("Unsupported canonicalization version");

    expect(
      revalidateApprovedInvocation(
        approval(artifact),
        { ...artifact, canonicalizationVersion: "narwhal-json-c14n/v999" },
        new Date("2026-09-08T12:00:00.000Z"),
      ),
    ).toEqual({ ok: false, reason: "canonicalization-version-mismatch" });
  });

  it("models canonicalization independently from the tool contract version", () => {
    const artifact = resolution();
    expect(artifact.canonicalizationVersion).toBe(CANONICALIZATION_ID);
    expect(artifact.toolContractVersion).toBe("v2");
  });
});
