import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("APP_VERSION", "1.0.17")
vi.stubEnv("APP_COMMIT", "abcdef1234567")
afterEach(() => vi.unstubAllEnvs())

import { NavVersion } from "./nav"

describe("NavVersion", () => {
  it("renders the short build version with an accessible label and full SHA title", () => {
    const html = renderToString(<NavVersion label="Portal version and commit" />)
    expect(html).toContain("v1.0.17 · abcdef1")
    expect(html).toContain('aria-label="Portal version and commit"')
    expect(html).toContain('title="abcdef1234567"')
  })
})
