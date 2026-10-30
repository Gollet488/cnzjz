import { defineConfig } from '@playwright/test';

// Both projects open the real index.html. No QA page or product test hook.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: /flows\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/browser',
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.BROWSER_CHANNEL || undefined,
  },
  projects: [
    { name: 'dev', use: { baseURL: 'http://127.0.0.1:5186' } },
    { name: 'production', use: { baseURL: 'http://127.0.0.1:5187' } },
  ],
  webServer: [
    {
      command: 'node scripts/browser-server.mjs dev',
      url: 'http://127.0.0.1:5186',
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'node scripts/browser-server.mjs production',
      url: 'http://127.0.0.1:5187',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
