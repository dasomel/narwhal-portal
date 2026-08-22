#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Asserts the build-time dependency trust boundary is still in place.
//
// Every control here is one line in a config file, which is exactly why it needs a
// check: `pnpm approve-builds` appends to onlyBuiltDependencies, a new workflow copies
// an install step without --frozen-lockfile, someone deletes .npmrc while cleaning up.
// None of those look like a security change in review.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const problems = []
const read = (p) => {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return null
  }
}

// 1. No dependency may run an install script.
const ws = read("pnpm-workspace.yaml")
if (ws === null) {
  problems.push("pnpm-workspace.yaml is missing — the build-script policy lives there")
} else {
  if (!/^onlyBuiltDependencies:\s*\[\]\s*$/m.test(ws)) {
    problems.push(
      "pnpm-workspace.yaml: onlyBuiltDependencies must be an explicit empty list.\n" +
        "    A non-empty allowlist means some package runs code at install time; if that is\n" +
        "    intended, say so here and in the issue, do not just let approve-builds write it.",
    )
  }
  // The cooling window must NOT be set here. pnpm applies minimumReleaseAge to the whole
  // graph at resolution time, so one young transitive dependency blocks every lockfile
  // operation — with it set, every Dependabot update failed, security ones included. The
  // window is enforced on the lockfile delta instead; re-adding this key silently
  // re-breaks dependency updates and looks like a hardening change while doing it.
  if (/^minimumReleaseAge:\s*\d+\s*$/m.test(ws)) {
    problems.push(
      "pnpm-workspace.yaml: minimumReleaseAge is set again.\n" +
        "    It gates resolution of the whole graph, not the versions a change introduces, so it\n" +
        "    blocks every dependency update until the youngest package already in the lockfile\n" +
        "    matures. scripts/check-lockfile-cooling.mjs enforces the same window on the delta.",
    )
  }
}

// 1a. Dependabot's own `cooldown` reaches pnpm as the same graph-wide flag
//     (`--config.minimumReleaseAge=10080`), so setting it there re-breaks every update
//     exactly the way setting it in pnpm-workspace.yaml did. It reads as a hardening
//     change, which is why it needs a check rather than a comment.
const dependabot = read(".github/dependabot.yml")
if (dependabot !== null && /^\s*cooldown:/m.test(dependabot)) {
  problems.push(
    ".github/dependabot.yml: cooldown is set.\n" +
      "    Dependabot passes it to pnpm as --config.minimumReleaseAge, which fails on transitive\n" +
      "    packages already in the lockfile. scripts/check-lockfile-cooling.mjs gates the PR instead.",
  )
}

// 1b. ...and the delta gate that replaced it is still there and still runs in CI.
const cooling = read("scripts/check-lockfile-cooling.mjs")
if (cooling === null) {
  problems.push("scripts/check-lockfile-cooling.mjs is missing — nothing enforces the cooling window")
} else {
  const days = /^const COOLING_DAYS = [^\n]*?: (\d+)\s*$/m.exec(cooling)
  if (!days) {
    problems.push("scripts/check-lockfile-cooling.mjs: cannot read the default COOLING_DAYS")
  } else if (Number(days[1]) < 3) {
    problems.push(`scripts/check-lockfile-cooling.mjs: cooling window is ${days[1]} days, below the 3-day floor`)
  }
  const wiredIn = readdirSync(".github/workflows")
    .map((f) => read(join(".github/workflows", f)) ?? "")
    .some((body) => body.includes("check-lockfile-cooling.mjs"))
  if (!wiredIn) {
    problems.push("no workflow runs scripts/check-lockfile-cooling.mjs — the gate exists but never fires")
  }
}

// 2. The lockfile is authoritative even when a flag is forgotten.
//    In pnpm-workspace.yaml rather than .npmrc: npm does not know the key and warns on
//    every npx invocation that it "will stop working", which trains people to ignore
//    warnings.
if (ws !== null && !/^frozenLockfile:\s*true\s*$/m.test(ws)) {
  problems.push("pnpm-workspace.yaml: frozenLockfile: true is missing")
}

// 3. Every install in CI and in the image is frozen. A bun install must additionally
//    pass --ignore-scripts, because bun does not block them the way pnpm 10 does.
const installers = /(pnpm|npm|bun)\s+(install|ci|add)\b[^\n]*/g
for (const file of [
  ...readdirSync(".github/workflows").map((f) => join(".github/workflows", f)),
  "Dockerfile",
  "Dockerfile.dev",
]) {
  const body = read(file)
  if (!body) continue
  for (const line of body.match(installers) ?? []) {
    if (/\bnpm\s+(install|add)\b/.test(line) && !/--frozen-lockfile|npm\s+ci\b/.test(line)) {
      problems.push(`${file}: unpinned install — ${line.trim()}`)
      continue
    }
    if (/\b(pnpm|bun)\s+install\b/.test(line) && !line.includes("--frozen-lockfile")) {
      problems.push(`${file}: install without --frozen-lockfile — ${line.trim()}`)
    }
    if (/\bbun\s+install\b/.test(line) && !line.includes("--ignore-scripts")) {
      problems.push(`${file}: bun install without --ignore-scripts — ${line.trim()}`)
    }
  }
}

if (problems.length) {
  console.error("supply-chain policy violations:\n")
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.error("supply-chain policy intact")
