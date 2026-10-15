import { defineConfig, devices } from "@playwright/test"

const baseURL = "http://localhost:3187"
const fixtureURL = "http://127.0.0.1:3199"
const valkeyFixtureURL = "redis://127.0.0.1:6380"

process.env.PLAYWRIGHT_E2E_FIXTURE_URL = fixtureURL
process.env.PLAYWRIGHT_E2E_VALKEY_URL = "http://127.0.0.1:3200"

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    // CI uses the Chrome preinstalled on GitHub-hosted runners: the egress-blocked job
    // cannot download Playwright's browser build (cdn.playwright.dev is refused).
    ...(process.env.CI ? { channel: "chrome" } : {}),
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/fixtures/valkey-server.mjs",
      url: `${process.env.PLAYWRIGHT_E2E_VALKEY_URL}/health`,
      reuseExistingServer: false,
      timeout: 10_000,
      name: "Offline Valkey protocol fixture",
    },
    {
      command: "node e2e/fixtures/upstream-server.mjs",
      url: `${fixtureURL}/health`,
      reuseExistingServer: false,
      timeout: 10_000,
      name: "Offline upstream fixtures",
    },
    {
      command: "pnpm dev --hostname localhost --port 3187",
      url: `${baseURL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AUTH_MOCK: "true",
        AUTH_SECRET: "playwright-only-secret-not-for-production",
        AUTH_URL: baseURL,
        NEXT_PUBLIC_AUTH_MOCK: "true",
        ARGOCD_URL: fixtureURL,
        ALERTMANAGER_URL: fixtureURL,
        K8S_API_SERVER: fixtureURL,
        VALKEY_URL: valkeyFixtureURL,
      },
    },
  ],
})
