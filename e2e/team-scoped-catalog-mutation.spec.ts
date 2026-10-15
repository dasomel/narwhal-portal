import { expect, test } from "@playwright/test"

const fixtureURL = process.env.PLAYWRIGHT_E2E_FIXTURE_URL

test("platform-team developer sees only mapped namespace apps and confirms an in-scope catalog sync", async ({ page, request }) => {
  if (!fixtureURL) throw new Error("PLAYWRIGHT_E2E_FIXTURE_URL is not configured")
  await request.post(`${fixtureURL}/__test/reset`)
  const valkeyStateURL = process.env.PLAYWRIGHT_E2E_VALKEY_URL
  if (!valkeyStateURL) throw new Error("PLAYWRIGHT_E2E_VALKEY_URL is not configured")
  await request.post(`${valkeyStateURL}/__test/reset`)

  await page.goto("/catalog")
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fcatalog$/)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: "Platform Team Developer으로 로그인" }).click()
  await expect(page).toHaveURL(/\/catalog$/)

  const permissions = await page.evaluate(async () => {
    const response = await fetch("/api/settings/effective-permissions")
    return { status: response.status, body: await response.json() }
  })
  expect(permissions.status).toBe(200)
  expect(permissions.body.identity.role).toBe("developer")
  expect(permissions.body.claims.mappedTeams).toEqual(["platform-team"])
  expect(permissions.body.allNamespaces).toBe(false)
  expect(permissions.body.namespaces).toEqual([
    expect.objectContaining({ name: "platform-e2e", via: "label", owner: "platform-team" }),
  ])
  expect(permissions.body.argocdProjects).toEqual(["platform"])

  await expect(page.getByRole("link", { name: "portal-e2e", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "frontend-e2e", exact: true })).toHaveCount(0)
  const outOfScopeDetail = await page.evaluate(async () => {
    const response = await fetch("/api/catalog/frontend-e2e")
    return response.status
  })
  expect(outOfScopeDetail).toBe(404)

  await page.getByRole("link", { name: "portal-e2e", exact: true }).click()
  await expect(page).toHaveURL(/\/catalog\/portal-e2e$/)
  await expect(page.getByRole("heading", { name: "portal-e2e", exact: true })).toBeVisible()
  await expect(page.getByText("platform-e2e", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "동기화", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByText("'portal-e2e' 서비스를 동기화하시겠습니까?")).toBeVisible()
  const syncResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/catalog/portal-e2e/sync") && response.request().method() === "POST",
  )
  await dialog.getByRole("button", { name: "동기화", exact: true }).click()

  const response = await syncResponse
  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body).toMatchObject({ success: true, app: { syncStatus: "Synced", revision: "verifie" } })
  expect(body.pending).toBeUndefined()
  await expect(page.getByText("동기화 요청이 전송되었습니다.", { exact: true })).toBeVisible()

  const fixtureState = await (await request.get(`${fixtureURL}/__test/state`)).json()
  expect(fixtureState.syncRequests).toBe(1)
  expect(fixtureState.readsAfterSync).toBeGreaterThan(0)
  expect(fixtureState.app.status).toMatchObject({
    sync: { status: "Synced", revision: "verified-sync-revision" },
    operationState: { phase: "Succeeded" },
  })

  const persistedEvents = await (await request.get(`${valkeyStateURL}/__test/state`)).json()
  expect(persistedEvents.events.map((event: { event_type: string }) => event.event_type)).toEqual([
    "operation.completed",
    "operation.started",
  ])
  expect(persistedEvents.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "operation", source: "argocd", event_type: "operation.started" }),
    expect.objectContaining({ type: "operation", source: "argocd", event_type: "operation.completed" }),
  ]))
})
