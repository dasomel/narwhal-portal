#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Independent reviewer's helper: after a PASS, post a commit status `independent-review`
// on the exact head SHA the reviewer reviewed. A new push means a new SHA with no status,
// so the required check blocks merge until re-reviewed. Procedural control (any writer can
// post it), not identity proof.
// Usage: node scripts/mark-review-pass.mjs <pr-number> --sha <full-40-hex-reviewed-sha>
// Exit: 0 only if posted AND head still equals the reviewed SHA; 1 refused/failed/head
// moved; 2 usage.

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const REPO = "dasomel/narwhal-portal"
export const CONTEXT = "independent-review"

// Pure decision over `gh pr view --json headRefOid,isDraft,state` and the reviewed SHA.
// Full 40-hex only (a prefix is grindable by an author), strict equality against the head.
export function planStatus(pr, reviewedSha) {
  if (!pr || typeof pr !== "object") return { ok: false, reason: "PR data missing" }
  if (pr.state !== "OPEN") return { ok: false, reason: `PR is not OPEN (state: ${pr.state})` }
  if (pr.isDraft !== false) return { ok: false, reason: "PR is a draft (or draft state unknown)" }
  const head = pr.headRefOid
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) {
    return { ok: false, reason: "headRefOid missing or not a 40-hex SHA" }
  }
  if (typeof reviewedSha !== "string" || !/^[0-9a-fA-F]{40}$/.test(reviewedSha)) {
    return { ok: false, reason: "--sha must be the FULL 40-hex reviewed SHA (no prefixes)" }
  }
  const sha = reviewedSha.toLowerCase()
  if (sha !== head) {
    return { ok: false, reason: `head moved or wrong SHA: reviewed ${sha} but PR head is ${head}; re-review the head` }
  }
  return { ok: true, sha, reason: `will mark ${sha.slice(0, 7)}` }
}

const realGh = (args) => execFileSync("gh", args, { encoding: "utf8" })

export function run(argv, gh = realGh, out = console) {
  const n = argv[0]
  const i = argv.indexOf("--sha")
  const reviewed = i > 0 ? argv[i + 1] : undefined
  if (!/^\d+$/.test(n ?? "")) {
    out.error("usage: mark-review-pass.mjs <pr-number> --sha <full-40-hex-sha>")
    return 2
  }
  const view = () => JSON.parse(gh(["pr", "view", n, "-R", REPO, "--json", "headRefOid,isDraft,state"]))
  try {
    const plan = planStatus(view(), reviewed)
    if (!plan.ok) {
      out.error(`refused: ${plan.reason}`)
      return 1
    }
    const sha = plan.sha
    gh([
      "api", `repos/${REPO}/statuses/${sha}`,
      "-f", "state=success",
      "-f", `context=${CONTEXT}`,
      "-f", `description=independent review PASS @${sha.slice(0, 7)}`,
    ])
    const after = view().headRefOid
    if (after !== sha) {
      out.error(`WARNING: head moved during marking (${sha.slice(0, 7)} -> ${String(after).slice(0, 7)}); the status is bound to the OLD sha (harmless); re-review the new head.`)
      return 1
    }
    out.log(`${CONTEXT} PASS posted for ${sha} (PR #${n})`)
    return 0
  } catch (err) {
    out.error(`failed: ${String(err.message).split("\n")[0]}`)
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)))
