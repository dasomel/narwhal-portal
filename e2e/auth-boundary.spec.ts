import { expect, test } from "@playwright/test"

test("redirects unauthenticated dashboard visits to mock login", async ({ page }) => {
  await page.goto("/")

  await expect(page).toHaveURL(/\/login\?callbackUrl=%2F$/)
  await expect(page.getByText("Narwhal IDP", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Viewer으로 로그인" })).toBeVisible()
})
