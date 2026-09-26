import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"

import { RouteLoadingFallback } from "./route-loading-fallback"

// See route-error-fallback.test.tsx for why this walks the element tree instead of the DOM,
// and why `props` is typed loosely rather than via React.ReactElement (whose props is `unknown`).
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

describe("RouteLoadingFallback", () => {
  it("renders an aria-busy role=status region", () => {
    const tree = RouteLoadingFallback({ label: "Loading..." })
    const statusEl = findByProp(tree, (el) => el.props?.role === "status")

    expect(statusEl).not.toBeNull()
    expect(statusEl?.props["aria-busy"]).toBe("true")
  })

  it("exposes the status text only to screen readers (sr-only)", () => {
    const tree = RouteLoadingFallback({ label: "Loading..." })
    const srText = findByProp(tree, (el) => el.props?.className === "sr-only")

    expect(srText).not.toBeNull()
    expect(collectText(srText)).toBe("Loading...")
  })
})
