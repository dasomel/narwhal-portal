import { describe, expect, it } from "vitest"
import {
  aggregateRestorePreflight,
  compareAndSetRestoreState,
  reconcileExecutingCrash,
  resolveRestoreTenantScope,
  RESTORE_STATES,
  type RestoreState,
} from "./restore"

const transitions: Record<RestoreState, RestoreState[]> = {
  pending: ["approved", "denied", "expired", "revoked", "invalidated"],
  approved: ["executing", "expired", "revoked", "invalidated"],
  denied: [],
  expired: [],
  revoked: [],
  invalidated: [],
  executing: ["reconciling", "succeeded", "failed"],
  reconciling: ["executing", "succeeded", "failed", "reconciling"],
  succeeded: [],
  failed: [],
}

describe("restore state transitions", () => {
  it("allows every documented transition", () => {
    for (const [from, destinations] of Object.entries(transitions) as [RestoreState, RestoreState[]][]) {
      for (const to of destinations) {
        expect(compareAndSetRestoreState({ state: from, version: 4 }, 4, to)).toEqual({
          applied: true,
          value: { state: to, version: 5 },
        })
      }
    }
  })

  it("rejects every undocumented transition, including terminal state reuse", () => {
    for (const from of RESTORE_STATES) {
      for (const to of RESTORE_STATES) {
        if (transitions[from].includes(to)) continue
        expect(compareAndSetRestoreState({ state: from, version: 0 }, 0, to)).toEqual({
          applied: false,
          reason: "invalid_transition",
        })
      }
    }
  })

  it("lets only one concurrent approve, cancel, or expiry decision win through versioned storage", async () => {
    let current = { state: "pending" as RestoreState, version: 0 }
    let writer = Promise.resolve()
    const readBarrier = createBarrier(3)
    const store = {
      read: async () => {
        const snapshot = current
        await readBarrier()
        return snapshot
      },
      update: async (expectedVersion: number, next: typeof current) => {
        let applied = false
        const commit = writer.then(() => {
          if (current.version !== expectedVersion) return
          current = next
          applied = true
        })
        writer = commit
        await commit
        return applied
      },
    }
    const contenders: RestoreState[] = ["approved", "revoked", "expired"]
    const results = await Promise.all(contenders.map(async (decision) => {
      const snapshot = await store.read()
      const transition = compareAndSetRestoreState(snapshot, snapshot.version, decision)
      if (!transition.applied) return transition
      const saved = await store.update(snapshot.version, transition.value)
      return saved ? transition : { applied: false as const, reason: "decision_conflict" as const }
    }))

    expect(results.filter((result) => result.applied)).toHaveLength(1)
    expect(results.filter((result) => !result.applied)).toHaveLength(2)
    expect(results.filter((result) => !result.applied).every((result) => result.reason === "decision_conflict")).toBe(true)
    expect(current.version).toBe(1)
    expect(["approved", "revoked", "expired"]).toContain(current.state)
  })

  it("returns a version conflict without changing state", () => {
    expect(compareAndSetRestoreState({ state: "pending", version: 3 }, 2, "approved")).toEqual({
      applied: false,
      reason: "decision_conflict",
    })
  })

  it("moves a crashed execution into reconciling", () => {
    expect(reconcileExecutingCrash({ state: "executing", version: 7 }, 7)).toEqual({
      applied: true,
      value: { state: "reconciling", version: 8 },
    })
  })
})

describe("restore preflight", () => {
  const requiredCheckIds = ["scope", "backup", "target", "storage", "dependencies", "compatibility", "capacity", "rpo-rto", "integrity"]
  const passingChecks = requiredCheckIds.map((checkId) => ({ checkId, status: "pass" as const }))

  it("blocks on any failure", () => {
    expect(aggregateRestorePreflight(requiredCheckIds, [
      { checkId: "backup", status: "pass" },
      { checkId: "storage", status: "fail" },
      { checkId: "integrity", status: "unknown" },
    ])).toBe("blocked")
  })

  it("requires evidence for unknown checks and permits warnings", () => {
    expect(aggregateRestorePreflight(["integrity"], [{ checkId: "integrity", status: "unknown" }])).toBe("needs-evidence")
    expect(aggregateRestorePreflight(["integrity"], [{ checkId: "integrity", status: "warning" }])).toBe("ready")
  })

  it("requires a nonempty complete, unique set of known check results", () => {
    expect(aggregateRestorePreflight([], [])).toBe("needs-evidence")
    expect(aggregateRestorePreflight(requiredCheckIds, passingChecks.slice(1))).toBe("needs-evidence")
    expect(aggregateRestorePreflight(["backup"], [
      { checkId: "backup", status: "pass" },
      { checkId: "backup", status: "pass" },
    ])).toBe("needs-evidence")
    expect(aggregateRestorePreflight(requiredCheckIds, [
      ...passingChecks,
      { checkId: "surprise", status: "pass" },
    ])).toBe("needs-evidence")
    expect(aggregateRestorePreflight(requiredCheckIds, passingChecks)).toBe("ready")
  })
})

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0
  let release: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    arrived += 1
    if (arrived === parties) release?.()
    await waiting
  }
}

describe("restore tenant scope", () => {
  it("uses server-resolved ownership rather than caller scope claims", () => {
    const callerScope = { namespace: "other-team-ns", ownerTeam: "attacker" }
    const serverScope = { namespace: "payments", ownerTeam: "finance" }

    expect(resolveRestoreTenantScope(serverScope)).toEqual({ namespace: "payments", ownerTeam: "finance" })
    expect(resolveRestoreTenantScope(serverScope)).not.toEqual(callerScope)
  })

  it("fails closed when server scope is unavailable or incomplete", () => {
    expect(resolveRestoreTenantScope(null)).toBeNull()
    expect(resolveRestoreTenantScope({ namespace: "payments", ownerTeam: " " })).toBeNull()
  })
})
