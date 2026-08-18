#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025 dasomel
//
// Generates THIRD-PARTY-NOTICES.md from the production dependency tree.
//
// WHY THIS EXISTS: MIT, BSD and ISC all require the copyright notice and the
// permission notice to travel with "all copies or substantial portions" of the
// software, and Apache-2.0 §4(d) requires any NOTICE the dependency ships to be
// propagated. The container image redistributes those packages, so the
// obligation attaches to the image, not just to this repository.
//
// It is not satisfied by the build output on its own: Next.js file tracing
// copies only the files the server needs at runtime, which strips LICENSE files.
// A build of 1.0.17 had 631 LICENSE files under node_modules and 3 under
// .next/standalone — so the published image shipped 34 packages' code with
// effectively no attribution. The Dockerfile copies this file into the image to
// close that gap.
//
// Deterministic by design — sorted, no timestamp — so CI can regenerate it and
// fail on a diff. Anything non-deterministic here would make that check useless.

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const OUT = "THIRD-PARTY-NOTICES.md"

// Licenses that need nothing beyond the notice this file already carries. Any
// license outside this set is surfaced in its own section, because a copyleft or
// unusual term is a decision for a human, not a row in a 600-line table.
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
])

// Per-package footnotes for anything whose presence in this list would otherwise
// mislead. The list is the full production dependency set, which is a SUPERSET of
// what any single image ships: platform-specific optional binaries for every
// architecture npm knows about resolve here, and file tracing drops packages the
// server never loads.
const PACKAGE_NOTES = [
  {
    match: /^@img\/sharp(-libvips)?-/,
    note:
      "**Not shipped in the container image.** Next.js pulls sharp in for its image optimizer; " +
      "image optimization is disabled and sharp is excluded from file tracing in `next.config.ts`, " +
      "because the portal imports `next/image` nowhere and libvips is LGPL-3.0-or-later. " +
      "See [`NOTICE`](./NOTICE). Verify with `find .next/standalone -ipath '*libvips*' -type f`.",
  },
]

const noteFor = (name) => PACKAGE_NOTES.find((n) => n.match.test(name))?.note

// Non-permissive licenses that have been looked at and accepted, with the reason.
// A license that is in neither PERMISSIVE nor here fails --strict, which is the
// point: a new copyleft dependency should stop CI and get a human decision, not
// land quietly as one more row in a 600-line table.
const ACCEPTED = new Map([
  [
    "LGPL-3.0-or-later",
    "sharp/libvips only; excluded from the image via next.config.ts — see NOTICE",
  ],
  ["CC-BY-4.0", "caniuse-lite data tables; attribution-only, satisfied by this file"],
  ["MIT AND ISC", "victory-vendor; both halves permissive"],
  ["(MIT OR CC0-1.0)", "type-fest; either half is permissive, MIT elected"],
])

const STRICT = process.argv.includes("--strict")

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|LICENCE)(\.|$)/i
const NOTICE_FILE = /^NOTICE(\.|$)/i

/** Reads the verbatim license text a package ships, if it ships one. */
function readLegalFiles(dir, matcher) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !matcher.test(e.name)) continue
    try {
      // CRLF must be normalized here. Some packages ship license files with
      // Windows line endings; git stores them as LF, so a generator that emits
      // CRLF produces a file that differs from its own checkout and makes the
      // CI staleness check fail on every run regardless of the change.
      const text = readFileSync(join(dir, e.name), "utf8").replace(/\r\n?/g, "\n").trim()
      if (text) out.push({ file: e.name, text })
    } catch {
      /* unreadable file is reported as missing, below */
    }
  }
  return out
}

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})

/** @type {Array<{name:string,version:string,license:string,author?:string,homepage?:string,dir?:string}>} */
const pkgs = []
for (const [license, entries] of Object.entries(JSON.parse(raw))) {
  for (const e of entries) {
    for (const version of e.versions ?? ["unknown"]) {
      pkgs.push({
        name: e.name,
        version,
        license,
        author: typeof e.author === "string" ? e.author : undefined,
        homepage: typeof e.homepage === "string" ? e.homepage : undefined,
        dir: e.paths?.find((p) => p.includes(`${e.name.replace("/", "+")}@${version}`)) ?? e.paths?.[0],
      })
    }
  }
}
pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const byLicense = new Map()
for (const p of pkgs) byLicense.set(p.license, (byLicense.get(p.license) ?? 0) + 1)
const licenseRows = [...byLicense.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const flagged = licenseRows.filter(([l]) => !PERMISSIVE.has(l))

const md = []
md.push("# Third-Party Notices")
md.push("")
md.push(
  "The Narwhal IDP Portal redistributes the npm packages listed here inside its container",
  "image (`ghcr.io/dasomel/narwhal-portal`). Their copyright and permission notices are",
  "reproduced below as those licenses require. The portal's own code is Apache-2.0; see",
  "[`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).",
)
md.push("")
md.push("**Do not edit this file by hand.** Regenerate it:")
md.push("")
md.push("```bash")
md.push("pnpm run notices")
md.push("```")
md.push("")
md.push(`Scope: production dependencies only (\`pnpm licenses list --prod\`) — ${pkgs.length} packages.`)
md.push("Development-only tooling is not redistributed and is therefore out of scope.")
md.push("")
md.push(
  "This is a **superset** of what any single image ships. Platform-specific optional binaries",
  "resolve for the build host's architecture, and Next.js file tracing drops packages the server",
  "never loads. Over-attribution is harmless; under-attribution is not, so the list is not pruned.",
)
md.push("")
md.push("## License summary")
md.push("")
md.push("| License | Packages |")
md.push("|---|---:|")
for (const [license, count] of licenseRows) md.push(`| ${license} | ${count} |`)
md.push("")

if (flagged.length) {
  md.push("## Licenses needing attention")
  md.push("")
  md.push(
    "These are not plain permissive licenses. Each carries an obligation beyond attribution,",
    "or is an SPDX expression rather than a single identifier.",
  )
  md.push("")
  for (const [license] of flagged) {
    md.push(`### ${license}`)
    md.push("")
    for (const p of pkgs.filter((p) => p.license === license)) {
      md.push(`- \`${p.name}@${p.version}\`${p.homepage ? ` — ${p.homepage}` : ""}`)
      const note = noteFor(p.name)
      if (note) md.push(`  ${note}`)
    }
    md.push("")
  }
}

md.push("## Packages")
md.push("")
for (const p of pkgs) {
  md.push(`### ${p.name}@${p.version}`)
  md.push("")
  md.push(`- License: \`${p.license}\``)
  if (p.author) md.push(`- Author: ${p.author}`)
  if (p.homepage) md.push(`- Homepage: ${p.homepage}`)
  const note = noteFor(p.name)
  if (note) md.push(`- ${note}`)
  md.push("")

  const licenses = p.dir ? readLegalFiles(p.dir, LICENSE_FILE) : []
  const notices = p.dir ? readLegalFiles(p.dir, NOTICE_FILE) : []
  if (licenses.length === 0 && notices.length === 0) {
    // Not a compliance hole by itself — many packages declare SPDX in
    // package.json and ship no file. The declared identifier above is the notice.
    md.push("_No license file shipped with the package; the SPDX identifier above is its declaration._")
    md.push("")
    continue
  }
  for (const f of [...licenses, ...notices]) {
    md.push(`<details><summary>${f.file}</summary>`)
    md.push("")
    md.push("```")
    md.push(f.text.replace(/```/g, "'''"))
    md.push("```")
    md.push("")
    md.push("</details>")
    md.push("")
  }
}

writeFileSync(OUT, md.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n")
console.error(`${OUT}: ${pkgs.length} packages, ${licenseRows.length} distinct licenses`)
for (const [license, count] of flagged) {
  const reason = ACCEPTED.get(license)
  console.error(`  ${reason ? "accepted" : "UNREVIEWED"}: ${license} (${count})${reason ? ` — ${reason}` : ""}`)
}

const unreviewed = flagged.filter(([license]) => !ACCEPTED.has(license))
if (STRICT && unreviewed.length) {
  for (const [license] of unreviewed) {
    const names = pkgs.filter((p) => p.license === license).map((p) => `${p.name}@${p.version}`)
    console.error(`::error::unreviewed license ${license}: ${names.join(", ")}`)
  }
  console.error(
    "Add it to ACCEPTED in scripts/generate-third-party-notices.mjs with the reason, " +
      "or drop the dependency. Do not widen PERMISSIVE to make this pass.",
  )
  process.exit(1)
}
