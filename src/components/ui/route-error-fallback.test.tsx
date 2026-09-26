import { describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import { RouteErrorFallback } from "./route-error-fallback"

// No jsdom/RTL is set up in this repo (vitest runs in the default "node" environment), so
// these tests walk the returned React element tree directly instead of rendering to a DOM.
// RouteErrorFallback has no hooks, so calling it as a plain function is safe (rendering a
// component that calls hooks this way would throw "invalid hook call").
// Loosely typed on purpose: `React.ReactElement`'s `props` is `unknown`, but every element in
// this tree (our own components, lucide icons, DOM elements) carries a plain props object.
interface LooseElement {
  props: Record<string, any>
}

function isElement(node: unknown): node is LooseElement {
  return typeof node === "object" && node !== null && "props" in node
}

function collectText(node: ReactNode | LooseElement): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(collectText).join("")
  if (isElement(node)) return collectText(node.props.children)
  return ""
}

function findByProp(node: ReactNode, predicate: (el: LooseElement) => boolean): LooseElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByProp(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!isElement(node)) return null
  if (predicate(node)) return node
  return findByProp(node.props.children, predicate)
}

function baseProps(overrides: Partial<Parameters<typeof RouteErrorFallback>[0]> = {}) {
  return {
    error: Object.assign(new Error("boom"), { digest: "abc123" }),
    onRetry: vi.fn(),
    title: "Something went wrong",
    description: "An error occurred while loading this page.",
    retryLabel: "Retry",
    digestLabel: "Error reference",
    ...overrides,
  }
}

describe("RouteErrorFallback", () => {
  it("renders role=alert with a visible heading and description", () => {
    const tree = RouteErrorFallback(baseProps())
    const alertEl = findByProp(tree, (el) => el.props?.role === "alert")

    expect(alertEl).not.toBeNull()
    const text = collectText(alertEl)
    expect(text).toContain("Something went wrong")
    expect(text).toContain("An error occurred while loading this page.")
  })

  it("shows the error digest for support when present", () => {
    const tree = RouteErrorFallback(baseProps())
    expect(collectText(tree)).toContain("Error reference: abc123")
  })

  it("omits the digest line when the error has no digest", () => {
    const props = baseProps({ error: new Error("boom") })
    const tree = RouteErrorFallback(props)
    expect(collectText(tree)).not.toContain("Error reference")
  })

  it("wires the retry button to the onRetry callback", () => {
    const onRetry = vi.fn()
    const tree = RouteErrorFallback(baseProps({ onRetry }))
    const button = findByProp(tree, (el) => typeof el.props?.onClick === "function")

    expect(button).not.toBeNull()
    expect(button?.props.onClick).toBe(onRetry)

    button?.props.onClick()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
