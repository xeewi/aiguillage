import { defineConfig, devices } from '@playwright/test'

// Each test gets its own Aiguillage server + fake claude (test/e2e/fixtures.js): nothing shared, nothing real.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 2,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, headless: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
