import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const script = new URL("./check-regression-results.mjs", import.meta.url)
function run(unit, browser) {
  const env = { ...process.env }
  delete env.UNIT_API_RESULT
  delete env.BROWSER_RESULT
  if (unit !== undefined) env.UNIT_API_RESULT = unit
  if (browser !== undefined) env.BROWSER_RESULT = browser
  return spawnSync(process.execPath, [script.pathname], { env, encoding: "utf8" })
}

test("only both observed success results pass", () => {
  const result = run("success", "success")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /All critical/)
})
for (const state of ["failure", "cancelled", "skipped", undefined, "", "Success"]) {
  for (const suite of ["unit", "browser"]) {
    test(`${suite} ${String(state)} fails the required gate`, () => {
      const result = suite === "unit" ? run(state, "success") : run("success", state)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /did not succeed/)
    })
  }
}
