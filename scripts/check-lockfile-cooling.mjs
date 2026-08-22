#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Gates lockfile updates by enforcing a cooling window on newly added package versions.
//
// pnpm's built-in `minimumReleaseAge` constraint operates at resolution time across the
// entire dependency graph, causing any lockfile modification to fail if any transitive
// package in the tree is younger than the window. That breaks routine security updates.
// This check gates the lockfile delta instead, ensuring new package versions mature
// before entry while allowing existing locked versions to re-resolve freely.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

// Map of name@version -> reason for bypassing the cooling window.
// Every entry is a deliberate hole in supply-chain cooling and must carry a non-empty reason.
const COOLING_EXCEPTIONS = {}

const envDays = parseInt(process.env.COOLING_DAYS || "", 10)
const COOLING_DAYS = !isNaN(envDays) && envDays >= 1 ? envDays : 7
const COOLING_MS = COOLING_DAYS * 24 * 60 * 60 * 1000

// Determine base git ref to compare current lockfile against.
const resolveBaseRef = () => {
  if (process.argv[2]) return process.argv[2]
  if (process.env.COOLING_BASE_REF) return process.env.COOLING_BASE_REF
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD~1"], { stdio: "ignore" })
    return "HEAD~1"
  } catch {
    return null
  }
}

// Parses pnpm-lock.yaml packages block into a Set of name@version strings.
const parseLockfilePackages = (content) => {
  const packages = new Set()
  if (!content) return packages
  let inPackages = false
  for (const line of content.split("\n")) {
    if (!inPackages) {
      if (/^packages:/.test(line)) {
        inPackages = true
      }
      continue
    }
    if (/^[a-zA-Z]/.test(line)) {
      inPackages = false
      continue
    }
    if (!/^  [^ ]/.test(line)) continue
    let item = line.trim()
    if (!item.endsWith(":")) continue
    item = item.slice(0, -1).trim()
    if (item.startsWith("'") && item.endsWith("'")) {
      item = item.slice(1, -1)
    } else if (item.startsWith('"') && item.endsWith('"')) {
      item = item.slice(1, -1)
    }
    // Strip a peer-dependency suffix before splitting: `vite@8.2.2(jiti@2.7.0)` would
    // otherwise split on the `@` inside the suffix and yield a package named `vite@8.2.2(jiti`.
    const paren = item.indexOf("(")
    if (paren !== -1) item = item.slice(0, paren)
    const lastAt = item.lastIndexOf("@")
    if (lastAt <= 0) continue
    const name = item.slice(0, lastAt)
    const version = item.slice(lastAt + 1)
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    packages.add(`${name}@${version}`)
  }
  return packages
}

// Fetches items with a concurrency limit.
const mapConcurrent = async (items, limit, fn) => {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

const main = async () => {
  const baseRef = resolveBaseRef()
  if (baseRef === null) {
    console.error("lockfile cooling: no base ref to compare, skipping check")
    process.exit(0)
  }

  let baseContent = ""
  try {
    baseContent = execFileSync("git", ["show", `${baseRef}:pnpm-lock.yaml`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    baseContent = ""
  }

  let currentContent = ""
  try {
    currentContent = readFileSync("pnpm-lock.yaml", "utf8")
  } catch {
    currentContent = ""
  }

  const basePackages = parseLockfilePackages(baseContent)
  const currentPackages = parseLockfilePackages(currentContent)

  const newPackages = Array.from(currentPackages).filter((pkg) => !basePackages.has(pkg))
  if (newPackages.length === 0) {
    console.error("lockfile cooling: no lockfile change")
    process.exit(0)
  }

  const packagesByName = new Map()
  for (const pkg of newPackages) {
    const lastAt = pkg.lastIndexOf("@")
    const name = pkg.slice(0, lastAt)
    const version = pkg.slice(lastAt + 1)
    if (!packagesByName.has(name)) {
      packagesByName.set(name, [])
    }
    packagesByName.get(name).push(version)
  }

  const isOffline = process.env.COOLING_OFFLINE === "1"
  const violations = []
  const fetchErrors = []
  const now = Date.now()

  const packageNames = Array.from(packagesByName.keys())
  await mapConcurrent(packageNames, 8, async (name) => {
    const versions = packagesByName.get(name)
    const encodedName = encodeURIComponent(name)
    let data = null
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodedName}`, {
        headers: { accept: "application/json" },
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      data = await res.json()
    } catch (err) {
      if (isOffline) {
        console.error(`lockfile cooling warning: failed to fetch ${name} (${err.message}), skipping offline`)
        return
      }
      fetchErrors.push(`failed to fetch metadata for ${name}: ${err.message}`)
      return
    }

    const times = data.time || {}
    for (const ver of versions) {
      const pkgKey = `${name}@${ver}`
      if (Object.prototype.hasOwnProperty.call(COOLING_EXCEPTIONS, pkgKey)) {
        const reason = COOLING_EXCEPTIONS[pkgKey]
        if (typeof reason !== "string" || reason.trim() === "") {
          violations.push(`${pkgKey}: COOLING_EXCEPTIONS entry has an empty or invalid reason`)
        } else {
          console.error(`  ~ ${pkgKey} exempt: ${reason}`)
        }
        continue
      }

      const pubStr = times[ver]
      if (!pubStr) {
        if (isOffline) {
          console.error(`lockfile cooling warning: release time missing for ${pkgKey}, skipping offline`)
        } else {
          violations.push(`${pkgKey}: release time not found in npm registry`)
        }
        continue
      }

      const pubTime = new Date(pubStr).getTime()
      const ageMs = now - pubTime
      if (ageMs < COOLING_MS) {
        const daysAgo = Math.floor(ageMs / (1000 * 60 * 60 * 24))
        violations.push(`  - ${pkgKey} published ${daysAgo} days ago (${pubStr})`)
      }
    }
  })

  if (fetchErrors.length > 0) {
    console.error("lockfile cooling fetch errors:")
    for (const err of fetchErrors) {
      console.error(`  - ${err}`)
    }
  }

  if (violations.length > 0 || fetchErrors.length > 0) {
    if (violations.length > 0) {
      console.error("lockfile cooling violations:")
      for (const v of violations) {
        console.error(v.startsWith("  ") ? v : `  - ${v}`)
      }
      console.error(
        `\nNewly added package versions must mature for at least ${COOLING_DAYS} days before entering the lockfile.\n` +
          "To resolve, either wait for the package version to mature, or add an entry to COOLING_EXCEPTIONS in this script with a documented justification.",
      )
    }
    process.exit(1)
  }

  console.error(`lockfile cooling: ${newPackages.length} new package versions, all at least ${COOLING_DAYS} days old`)
}

main().catch((err) => {
  console.error(`lockfile cooling unexpected error: ${err.message}`)
  process.exit(1)
})
