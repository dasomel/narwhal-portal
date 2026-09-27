import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

import { ConnectionIndicator } from "./connection-indicator"
import { LocaleProvider } from "@/lib/i18n-client"

describe("ConnectionIndicator", () => {
  it("announces connection changes with a text label independent of color", () => {
    for (const [status, label] of [
      ["live", "Live"],
      ["reconnecting", "Reconnecting…"],
      ["disconnected", "Disconnected"],
      ["connecting", "Connecting…"],
    ] as const) {
      const html = renderToStaticMarkup(
        <LocaleProvider locale="en">
          <ConnectionIndicator status={status} />
        </LocaleProvider>,
      )

      expect(html).toContain('role="status"')
      expect(html).toContain('aria-live="polite"')
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain(label)
    }
  })
})
