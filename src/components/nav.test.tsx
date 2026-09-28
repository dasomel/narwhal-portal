import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "admin narwhal", role: "cluster-admin" } } }),
}))
vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
vi.mock("@/lib/i18n-client", () => ({
  useT: () => (key: string) => key,
  LocaleSwitcher: () => null,
}))
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/components/dependency-health-indicator", () => ({ DependencyHealthIndicator: () => <span role="status">모든 시스템 정상</span> }))

beforeEach(() => {
  vi.stubEnv("APP_VERSION", "1.0.17")
  vi.stubEnv("APP_COMMIT", "abcdef1234567")
})
afterEach(() => vi.unstubAllEnvs())

import { getOverflowNavItems, getVisibleNavItemCount, getVisibleNavItems, Nav, NavVersion } from "./nav"

describe("Nav", () => {
  it("keeps all navigation labels on one line and accounts for the real header conditions", () => {
    const html = renderToString(<Nav />)
    const menuLinks = [...html.matchAll(/<a\b([^>]*)>/g)]
      .map(([_, attributes]) => attributes)
      .filter((attributes) => attributes.includes("text-sm"))

    expect(menuLinks).toHaveLength(13)
    for (const attributes of menuLinks) {
      expect(attributes).toContain("whitespace-nowrap")
      expect(attributes).toContain("shrink-0")
    }
    expect(html).toContain('role="status">모든 시스템 정상</span>')
    expect(html).toContain("admin narwhal")
    expect(html).toContain('aria-label="nav.more"')
    expect(html).toContain('class="whitespace-nowrap">search.hint</span>')
  })

  it("moves every item that does not fit into the reachable More menu", () => {
    const count = getVisibleNavItemCount([70, 70, 90, 90], 180, 80, 4)
    const items = getVisibleNavItems("cluster-admin")
    const overflow = getOverflowNavItems(items, count)
    expect(count).toBe(1)
    expect(overflow.map(({ href }) => href)).toEqual(items.slice(1).map(({ href }) => href))
    expect(items.slice(0, count).concat(overflow)).toEqual(items)
  })
})

describe("NavVersion", () => {
  it("renders the short build version with an accessible label and full SHA title", () => {
    const html = renderToString(<NavVersion label="Portal version and commit" />)
    expect(html).toContain("v1.0.17 · abcdef1")
    expect(html).toContain('aria-label="Portal version and commit"')
    expect(html).toContain('title="abcdef1234567"')
  })
})
