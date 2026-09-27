import { describe, expect, it, vi } from "vitest"
vi.mock("server-only", () => ({}))

import { jobStatusPollTimeoutMs } from "./k8s-job-runner"

describe("jobStatusPollTimeoutMs", () => {
  it("caps a status poll at the remaining overall job budget", () => {
    expect(jobStatusPollTimeoutMs(10_000, 9_750)).toBe(250)
  })

  it("keeps the normal status poll timeout at one minute", () => {
    expect(jobStatusPollTimeoutMs(120_000, 0)).toBe(60_000)
  })
})
