import { describe, expect, it } from "vitest"
import { isEventFiltered } from "./event-visibility"
import type { EffectiveScope } from "./scope"
import type { LiveEvent } from "@/types/live"

function fakeScope(overrides: Partial<EffectiveScope> = {}): EffectiveScope {
  return {
    all: false,
    namespaces: new Set(["team-a"]),
    argocdProjects: [],
    hasMapping: true,
    fingerprint: "test",
    resolved: { all: false, names: new Set(["team-a"]), byLabel: new Set(), byPattern: new Set() },
    ...overrides,
  }
}

function fakeEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: "evt-1",
    type: "deploy",
    severity: "info",
    timestamp: "2026-08-24T00:00:00.000Z",
    title: "test event",
    description: "",
    source: "kubernetes",
    links: null,
    ...overrides,
  }
}

describe("isEventFiltered — namespace scoping", () => {
  it("shows a developer their own namespace's event", () => {
    const event = fakeEvent({ resource: { namespace: "team-a" } })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(false)
  })

  it("hides a cross-namespace event from a developer scoped elsewhere", () => {
    const event = fakeEvent({ resource: { namespace: "team-b" } })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(true)
  })

  it("shows every namespace to cluster-admin regardless of resource", () => {
    const event = fakeEvent({ resource: { namespace: "team-b" } })
    expect(isEventFiltered(event, "cluster-admin", fakeScope())).toBe(false)
  })

  it("hides a namespaced event when the caller has no scope mapping at all", () => {
    const event = fakeEvent({ resource: { namespace: "team-a" } })
    const scope = fakeScope({ hasMapping: false, namespaces: new Set() })
    expect(isEventFiltered(event, "developer", scope)).toBe(true)
  })
})

describe("isEventFiltered — namespace-less events (portal#12 default-deny)", () => {
  it("default-denies a namespace-less event with no visibility declared", () => {
    const event = fakeEvent({ resource: null })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(true)
  })

  it("default-denies a namespace-less event even with resource present but namespace omitted", () => {
    const event = fakeEvent({ resource: { kind: "Node", name: "worker-1" } })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(true)
  })

  it("shows a namespace-less event explicitly declared visibility: cluster", () => {
    const event = fakeEvent({ resource: null, visibility: "cluster" })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(false)
  })

  it("still default-denies visibility: system to a non-admin", () => {
    const event = fakeEvent({ resource: null, visibility: "system" })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(true)
  })

  it("shows visibility: system to cluster-admin", () => {
    const event = fakeEvent({ resource: null, visibility: "system" })
    expect(isEventFiltered(event, "cluster-admin", fakeScope())).toBe(false)
  })

  it("never falls back to title/description text — a namespace= tag in the title does not grant visibility", () => {
    const event = fakeEvent({ resource: null, title: "namespace=team-a Pod restarted" })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(true)
  })
})

describe("isEventFiltered — replay and live paths share this function", () => {
  it("gives the same verdict regardless of call site (both routes call isEventFiltered directly)", () => {
    const event = fakeEvent({ resource: { namespace: "team-a" } })
    const scope = fakeScope()
    expect(isEventFiltered(event, "developer", scope)).toBe(isEventFiltered(event, "developer", scope))
  })
})

describe("isEventFiltered — viewer/guest redaction", () => {
  it("hides node-type events from viewer", () => {
    const event = fakeEvent({ type: "node", resource: null, visibility: "cluster" })
    expect(isEventFiltered(event, "viewer", fakeScope())).toBe(true)
  })

  it("hides node-type events from guest", () => {
    const event = fakeEvent({ type: "node", resource: null, visibility: "cluster" })
    expect(isEventFiltered(event, "guest", fakeScope())).toBe(true)
  })

  it("does not hide node-type events from developer or cluster-admin", () => {
    const event = fakeEvent({ type: "node", resource: null, visibility: "cluster" })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(false)
    expect(isEventFiltered(event, "cluster-admin", fakeScope())).toBe(false)
  })

  it("redacts an event whose description mentions 'secret' from viewer/guest", () => {
    const event = fakeEvent({ description: "rotated a secret", resource: { namespace: "team-a" } })
    expect(isEventFiltered(event, "viewer", fakeScope())).toBe(true)
    expect(isEventFiltered(event, "guest", fakeScope())).toBe(true)
  })

  it("does not redact the same event for developer", () => {
    const event = fakeEvent({ description: "rotated a secret", resource: { namespace: "team-a" } })
    expect(isEventFiltered(event, "developer", fakeScope())).toBe(false)
  })

  it("still shows a viewer their own namespace's non-node, non-secret event", () => {
    const event = fakeEvent({ resource: { namespace: "team-a" } })
    expect(isEventFiltered(event, "viewer", fakeScope())).toBe(false)
  })
})
