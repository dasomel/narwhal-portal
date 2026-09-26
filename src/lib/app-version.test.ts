import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { getAppVersion } from "./app-version"

describe("getAppVersion", () => {
  it("falls back to the development version without build metadata", () => {
    expect(getAppVersion(undefined, undefined)).toMatchObject({
      commit: "dev",
      shortCommit: "dev",
      version: "0.0.0-dev",
      display: "v0.0.0-dev · dev",
    })
  })

  it("does not import package.json into the client version helper", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/app-version.ts"), "utf8")
    expect(source).not.toMatch(/from\s+["'][^"']*package\.json["']/)
  })

  it("formats the commit as its first seven characters", () => {
    expect(getAppVersion("1.0.17", "abcdef1234567")).toMatchObject({
      version: "1.0.17",
      commit: "abcdef1234567",
      shortCommit: "abcdef1",
      display: "v1.0.17 · abcdef1",
    })
  })
})
