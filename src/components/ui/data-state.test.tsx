import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

vi.mock("@/lib/i18n-client", () => ({
  useT: () => (key: string, params?: Record<string, string>) => {
    const labels: Record<string, string> = {
      "dataState.loading": "Loading data.",
      "dataState.ok": "Data is up to date.",
      "dataState.partial": "Some data is available.",
      "dataState.stale": "Data is stale.",
      "dataState.empty": "No data to display.",
      "dataState.unavailable": "The data provider is unavailable.",
      "dataState.unauthorized": "You are not authorized to access this data.",
      "dataState.error": "Could not load data.",
      "dataState.updatedMinutes": `Updated ${params?.count} min ago`,
      "common.retry": "Retry",
    }
    return labels[key]
  },
}))

import { DataState } from "./data-state"
import { CostTelemetryState } from "@/components/cost/cost-overview"

interface Element { type: unknown; props: Record<string, any> }
function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "props" in node
}
function text(node: ReactNode | Element): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(text).join("")
  if (!isElement(node)) return ""
  if (typeof node.type === "function") return text((node.type as (props: Record<string, any>) => ReactNode)(node.props))
  return text(node.props.children)
}
function find(node: ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
  if (!isElement(node)) return undefined
  if (predicate(node)) return node
  if (typeof node.type === "function") return find((node.type as (props: Record<string, any>) => ReactNode)(node.props), predicate)
  return find(node.props.children, predicate)
}

describe("DataState", () => {
  it.each([
    ["loading", "status", "Loading data."],
    ["ok", "status", "Data is up to date."],
    ["partial", "status", "Some data is available."],
    ["stale", "status", "Data is stale."],
    ["empty", "status", "No data to display."],
    ["unavailable", "alert", "The data provider is unavailable."],
    ["unauthorized", "alert", "You are not authorized to access this data."],
    ["error", "alert", "Could not load data."],
  ] as const)("renders %s with its expected role and message", (state, role, message) => {
    const tree = DataState({ state })
    const element = find(tree, (item) => item.props.role === role)
    expect(element).toBeDefined()
    expect(text(element!)).toContain(message)
  })

  it("distinguishes provider outage from a genuine empty result", () => {
    expect(text(DataState({ state: "unavailable" }))).not.toBe(text(DataState({ state: "empty" })))
  })

  it("calls onRetry from its retry button", () => {
    const onRetry = vi.fn()
    const tree = DataState({ state: "error", onRetry })
    const button = find(tree, (element) => element.props.type === "button")
    expect(button).toBeDefined()
    button!.props.onClick()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("renders inline state with the same role and text without a border", () => {
    const tree = DataState({ state: "unavailable", reason: "Details", variant: "inline" })
    const alert = find(tree, (item) => item.props.role === "alert")
    const outer = find(tree, (item) => item.type === "div")
    expect(text(alert!)).toContain("The data provider is unavailable.")
    expect(text(alert!)).toContain("Details")
    expect(outer?.props.className).not.toContain("border")
  })

  it("shows freshness when supplied as an observation timestamp", () => {
    const tree = DataState({ state: "ok", observedAt: new Date(1_000_000).toISOString(), now: 1_120_000 })
    expect(text(tree)).toContain("Updated 2 min ago")
  })

  it("keeps alert text stable when freshness time changes", () => {
    const observedAt = new Date(1_000_000).toISOString()
    const first = find(DataState({ state: "unavailable", observedAt, now: 1_120_000 }), (item) => item.props.role === "alert")
    const second = find(DataState({ state: "unavailable", observedAt, now: 1_240_000 }), (item) => item.props.role === "alert")

    expect(text(first!)).toBe(text(second!))
  })

  it("renders an API unavailable telemetry state as unavailable on the cost surface", () => {
    const tree = CostTelemetryState({ state: { state: "unavailable" }, onRetry: vi.fn() })
    expect(text(tree)).toContain("The data provider is unavailable.")
    expect(text(tree)).not.toContain("No data to display.")
  })
})
