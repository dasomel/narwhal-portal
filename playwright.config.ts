import { defineConfig, devices } from "@playwright/test"

const baseURL = "http://127.0.0.1:3187"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3187",
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      AUTH_MOCK: "true",
      AUTH_SECRET: "playwright-only-secret-not-for-production",
      AUTH_URL: baseURL,
      NEXT_PUBLIC_AUTH_MOCK: "true",
    },
  },
})
