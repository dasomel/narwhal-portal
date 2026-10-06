#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Pre-merge independent-review gate. Green only when the PR carries `review:pass` AND
// that label was (re-)applied strictly AFTER the PR's latest change (newest commit
// committer date, or newest head_ref_force_pushed event). A later push therefore
// invalidates an earlier review without anyone having to remember to remove the label.
//
// Fails closed: draft, missing label, missing/odd data, or an unparseable timestamp all
// fail. Escape hatch is an admin merge, stated in the PR (see AGENTS.md).

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const REVIEW_LABEL = "review:pass"

const fail = (reason) => ({ ok: false, reason })
const toMs = (v) => (typeof v === "string" ? Date.parse(v) : NaN)

// `gh api --paginate` prints one JSON document per page, concatenated with no separator
// (`[..][..]`). Split top-level values by bracket depth (string/escape aware), parse each,
// and flatten arrays so callers see one list.
export function parseConcatenatedJson(text) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === "[" || c === "{") {
      if (depth === 0) start = i
      depth++
    } else if (c === "]" || c === "}") {
      depth--
      if (depth < 0) throw new Error("unbalanced JSON in gh output")
      if (depth === 0) {
        const v = JSON.parse(text.slice(start, i + 1))
        if (Array.isArray(v)) out.push(...v)
        else out.push(v)
      }
    }
  }
  if (depth !== 0 || inStr) throw new Error("truncated JSON in gh output")
  return out
}

// Pure decision. pr: pulls API object; timeline: issue timeline events; commits: pulls/{n}/commits.
export function evaluate({ pr, timeline, commits }) {
  if (!pr || typeof pr !== "object") return fail("PR data missing")
  if (pr.draft !== false) return fail("PR is a draft (or draft state unknown); review gate cannot pass")
  if (!Array.isArray(pr.labels) || !pr.labels.some((l) => l?.name === REVIEW_LABEL)) {
    return fail(`label '${REVIEW_LABEL}' is not on the PR`)
  }
  if (!Array.isArray(timeline) || timeline.length === 0) return fail("issue timeline is empty or missing")
  if (!Array.isArray(commits) || commits.length === 0) return fail("PR commit list is empty or missing")

  let labelMs = -Infinity
  let labeler = "unknown"
  for (const e of timeline) {
    if (e?.event !== "labeled" || e.label?.name !== REVIEW_LABEL) continue
    const t = toMs(e.created_at)
    if (Number.isNaN(t)) return fail("a 'labeled' event has an unparseable created_at")
    if (t > labelMs) {
      labelMs = t
      labeler = e.actor?.login ?? "unknown"
    }
  }
  if (labelMs === -Infinity) return fail(`no 'labeled' event for '${REVIEW_LABEL}' found in the timeline`)

  let changeMs = -Infinity
  let changeWhat = ""
  for (const c of commits) {
    const iso = c?.commit?.committer?.date
    const t = toMs(iso)
    if (Number.isNaN(t)) return fail(`commit ${String(c?.sha).slice(0, 7)} has no valid committer date`)
    if (t > changeMs) {
      changeMs = t
      changeWhat = `commit ${String(c.sha).slice(0, 7)} at ${iso}`
    }
  }
  for (const e of timeline) {
    if (e?.event !== "head_ref_force_pushed") continue
    const t = toMs(e.created_at)
    if (Number.isNaN(t)) return fail("a 'head_ref_force_pushed' event has an unparseable created_at")
    if (t > changeMs) {
      changeMs = t
      changeWhat = `force-push at ${e.created_at}`
    }
  }

  const labelIso = new Date(labelMs).toISOString()
  if (!(labelMs > changeMs)) {
    return fail(
      `'${REVIEW_LABEL}' applied by ${labeler} at ${labelIso} is not after the latest change (${changeWhat}); ` +
        "review is stale, re-review and re-apply the label",
    )
  }
  return {
    ok: true,
    reason: `'${REVIEW_LABEL}' applied by ${labeler} at ${labelIso}, after the latest change (${changeWhat})`,
  }
}

const gh = (args) =>
  execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })

function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const num = process.env.PR_NUMBER
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(num ?? "")) {
    console.error("independent-review: GITHUB_REPOSITORY and numeric PR_NUMBER are required")
    return 1
  }
  let verdict
  try {
    const pr = JSON.parse(gh([`repos/${repo}/pulls/${num}`]))
    const timeline = parseConcatenatedJson(gh(["--paginate", `repos/${repo}/issues/${num}/timeline?per_page=100`]))
    const commits = parseConcatenatedJson(gh(["--paginate", `repos/${repo}/pulls/${num}/commits?per_page=100`]))
    verdict = evaluate({ pr, timeline, commits })
  } catch (err) {
    verdict = fail(`could not fetch/parse PR data (${err.message})`)
  }
  console.log(`independent-review: ${verdict.ok ? "PASS" : "FAIL"} - ${verdict.reason}`)
  return verdict.ok ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main())
