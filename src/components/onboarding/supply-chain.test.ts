import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

// Issue #94: onboarding instructs users to download third-party executables outside CI.
// A mutable `releases/latest` (or `@latest`) URL in that content is still part of Portal's
// supply-chain trust boundary even though nothing here executes it. This is a static guard,
// not a runtime check — it fails the build if a mutable download command creeps back in.
const onboardingDir = dirname(fileURLToPath(import.meta.url))

// Explicitly classified discovery-only: comments/docs that merely reference kubelogin's
// latest-release page for humans to check for updates, not a command that downloads it.
const DISCOVERY_ONLY_MARKER = "discovery-only"

const MUTABLE_DOWNLOAD_PATTERNS = [/releases\/latest\/download/, /@latest\b/]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) return [full]
    return []
  })
}

describe("onboarding supply-chain: no mutable executable download URLs (issue #94)", () => {
  it("rejects releases/latest and @latest download commands in onboarding source", () => {
    const offenders: string[] = []

    for (const file of sourceFiles(onboardingDir)) {
      const content = readFileSync(file, "utf-8")
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        if (line.includes(DISCOVERY_ONLY_MARKER)) return
        for (const pattern of MUTABLE_DOWNLOAD_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`)
          }
        }
      })
    }

    expect(offenders, `Mutable executable download URL(s) found in onboarding content:\n${offenders.join("\n")}`).toEqual([])
  })
})
