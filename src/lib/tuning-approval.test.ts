import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { InMemoryIdempotencyStore, setIdempotencyStoreForTesting } from "@/lib/idempotency"
import {
  consumeTuningApproval,
  issueTuningApproval,
  validateTuningItems,
} from "@/lib/tuning-approval"

const actor = "admin@example.com"
const items = [{ kind: "swap-off" }] as const

beforeEach(() => {
  setIdempotencyStoreForTesting(new InMemoryIdempotencyStore())
})

afterEach(() => {
  setIdempotencyStoreForTesting(null)
})

describe("exact tuning approval runtime binding", () => {
  it("validates and binds allowlisted resolved arguments", () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    expect(issued.artifact.resolvedTarget).toEqual({ kind: "Node", name: "node-1" })
    expect(issued.artifact.normalizedResolvedArguments).toEqual({ items: [{ kind: "swap-off" }] })
    expect(issued.approval.invocationDigest).toBe(issued.artifact.invocationDigest)
  })

  it("consumes the exact approved invocation once", async () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    const first = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:01:00.000Z"),
    })
    expect(first.ok).toBe(true)

    const replay = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:01:01.000Z"),
    })
    expect(replay).toEqual({ ok: false, reason: "approval-replayed" })
  })

  it("rejects a changed target before side effects", async () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    const result = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-2",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:01:00.000Z"),
    })
    expect(result).toEqual({ ok: false, reason: "invocation-digest-mismatch" })
  })

  it("rejects changed arguments before side effects", async () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    const result = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-1",
      items: validateTuningItems([{ kind: "service-enable", service: "chronyd" }]),
      actor,
      now: new Date("2026-09-08T00:01:00.000Z"),
    })
    expect(result).toEqual({ ok: false, reason: "invocation-digest-mismatch" })
  })

  it("rejects an expired approval", async () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    const result = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:03:00.000Z"),
    })
    expect(result).toEqual({ ok: false, reason: "approval-expired" })
  })

  it("rejects an approval issued to a different authenticated actor", async () => {
    const validated = validateTuningItems(items)
    const issued = issueTuningApproval({
      nodeName: "node-1",
      items: validated,
      actor,
      now: new Date("2026-09-08T00:00:00.000Z"),
    })
    const result = await consumeTuningApproval({
      envelope: issued.approval,
      nodeName: "node-1",
      items: validated,
      actor: "other-admin@example.com",
      now: new Date("2026-09-08T00:01:00.000Z"),
    })
    expect(result).toEqual({ ok: false, reason: "invocation-digest-mismatch" })
  })
})
