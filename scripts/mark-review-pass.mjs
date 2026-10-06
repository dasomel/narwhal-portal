#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Independent reviewer's helper: after a PASS, post a commit status `independent-review`
// on the PR's CURRENT head SHA. A new push means a new SHA with no status, so the
// required check blocks merge until re-reviewed. Procedural control (any writer can post
// it), not identity proof. Usage: node scripts/mark-review-pass.mjs <pr-number> --sha <reviewed_sha>

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO = "dasomel/narwhal-portal"

// Pure decision over `gh pr view --json headRefOid,isDraft,state` and the SHA the
// reviewer actually reviewed (full 40-hex or a >=7-char prefix). Fail closed: the status
// is posted only on a head that still equals what was reviewed, so a push between review
// and posting can never be stamped PASS. Returns the resolved full SHA when ok.
export function planStatus(pr, reviewedSha) {
  if (!pr || typeof pr !== "object") return { ok: false, reason: "PR data missing" }
  if (pr.state !== "OPEN") return { ok: false, reason: `PR is not OPEN (state: ${pr.state})` }
  if (pr.isDraft !== false) return { ok: false, reason: "PR is a draft (or draft state unknown)" }
  const head = pr.headRefOid
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) {
    return { ok: false, reason: "headRefOid missing or not a 40-hex SHA" }
  }
  if (typeof reviewedSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(reviewedSha)) {
    return { ok: false, reason: "--sha <reviewed_sha> is required (7-40 hex chars)" }
  }
  if (!head.startsWith(reviewedSha.toLowerCase())) {
    return {
      ok: false,
      reason: `head moved or wrong SHA: reviewed ${reviewedSha.toLowerCase()} but PR head is ${head}; re-review the head`,
    }
  }
  return { ok: true, sha: head, reason: `will mark ${head.slice(0, 7)}` }
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8" })
const view = (n) => JSON.parse(gh(["pr", "view", n, "-R", REPO, "--json", "headRefOid,isDraft,state"]))

function main() {
  const n = process.argv[2]
  const i = process.argv.indexOf("--sha")
  const reviewed = i > 0 ? process.argv[i + 1] : undefined
  if (!/^\d+$/.test(n ?? "")) {
    console.error("usage: mark-review-pass.mjs <pr-number> --sha <reviewed_sha>")
    return 2
  }
  const pr = view(n)
  const plan = planStatus(pr, reviewed)
  if (!plan.ok) {
    console.error(`refused: ${plan.reason}`)
    return 1
  }
  const sha = plan.sha
  gh([
    "api", `repos/${REPO}/statuses/${sha}`,
    "-f", "state=success",
    "-f", "context=independent-review",
    "-f", `description=independent review PASS @${sha.slice(0, 7)}`,
  ])
  console.log(`independent-review PASS posted for ${sha} (PR #${n})`)
  const after = view(n).headRefOid
  if (after !== sha) {
    console.error(`WARNING: head moved during marking (${sha.slice(0, 7)} -> ${String(after).slice(0, 7)}); the status is bound to the OLD sha (harmless); re-review the new head.`)
    return 1
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
