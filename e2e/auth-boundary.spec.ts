import { expect, test } from "@playwright/test"

test("redirects unauthenticated dashboard visits to mock login", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveURL(/\/login\?callbackUrl=%2F$/)
  await expect(page.getByText("Narwhal IDP", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Viewer으로 로그인" })).toBeVisible()
})

test("rejects unauthenticated mutation requests", async ({ request }) => {
  const response = await request.post("/api/namespaces", { data: {} })
  expect(response.status()).toBe(401)
  expect(await response.json()).toEqual({ error: "Unauthorized" })
})

for (const { label, role, namespaceStatus, routesStatus } of [
  { label: "Viewer", role: "viewer", namespaceStatus: 403, routesStatus: 403 },
  { label: "Developer", role: "developer", namespaceStatus: 400, routesStatus: 403 },
  { label: "Cluster Admin", role: "cluster-admin", namespaceStatus: 400, routesStatus: 400 },
]) {
  test(`${label} session enforces mutation permissions`, async ({ page }) => {
    // D1: Use the real mock-provider login and session cookie, not intercepted API
    // responses. Invalid bodies prove gate passage without contacting providers;
    // successful mutations still require a separate disposable-provider fixture.
    // D2: Prime the anonymous CSRF cookie before mounting SessionProvider. Its
    // parallel initial requests can otherwise overwrite the token during signIn;
    // this isolates permission coverage, leaving first-visit login races separate.
    expect((await page.request.get("/api/auth/csrf")).status()).toBe(200)
    await page.goto("/login?callbackUrl=%2Fapi%2Fauth%2Fsession")
    await page.getByRole("button", { name: `${label}으로 로그인` }).click()
    await expect(page).toHaveURL(/\/api\/auth\/session$/)

    const session = await page.request.get("/api/auth/session")
    expect(session.status()).toBe(200)
    expect(await session.json()).toMatchObject({ user: { role }, groups: [role] })

    const namespace = await page.request.post("/api/namespaces", { data: {} })
    expect(namespace.status()).toBe(namespaceStatus)
    expect(await namespace.json()).toEqual({
      error: namespaceStatus === 403 ? "Forbidden" : "Invalid namespace name",
    })

    const routes = await page.request.patch("/api/settings/routes", { data: {} })
    expect(routes.status()).toBe(routesStatus)
    expect(await routes.json()).toEqual({
      error: routesStatus === 403 ? "Forbidden" : "Invalid input: id (string) and enable (boolean) required",
    })
  })
}
