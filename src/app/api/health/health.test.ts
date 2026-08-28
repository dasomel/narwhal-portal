import { describe, it, expect, vi } from "vitest"
import { GET as getLive } from "./live/route"
import { GET as getReady } from "./ready/route"
import { GET as getStatus } from "./status/route"

describe("Health Endpoints (Issue #63 & #60)", () => {
  it("liveness probe returns HTTP 200 with process info", async () => {
    const res = await getLive()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("ok")
    expect(json.service).toBe("narwhal-portal")
    expect(typeof json.uptime).toBe("number")
    expect(typeof json.pid).toBe("number")
  })

  it("readiness probe returns status and checks", async () => {
    const res = await getReady()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("ready")
    expect(json.checks.config).toBe("ok")
  })

  it("status diagnostics returns non-sensitive topology", async () => {
    const res = await getStatus()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dependencies).toBeDefined()
    expect(json.config).toBeDefined()
    // Ensure no secrets or passwords leaked
    const text = JSON.stringify(json)
    expect(text).not.toContain("password")
    expect(text).not.toContain("clientSecret")
    expect(text).not.toContain("bearer")
  })
})
