// D4: A required context must exist for every PR and fail on skipped/cancelled
// suites. Cost: full suites on docs PRs; a future conditional gate must still
// report this same context and validate every intentionally skipped path.
const results = {
  "unit/API": process.env.UNIT_API_RESULT,
  "browser": process.env.BROWSER_RESULT,
}
const incomplete = Object.entries(results).filter(([, result]) => result !== "success")
if (incomplete.length) {
  for (const [suite, result] of incomplete) console.error(`${suite} suite did not succeed: ${result ?? "missing"}`)
  process.exitCode = 1
} else {
  console.log("All critical Portal regression suites succeeded")
}
