import { defineConfig } from '@playwright/test';

const devURL = `http://127.0.0.1:${process.env.BROWSER_DEV_PORT ?? 5186}`;
const productionURL = `http://127.0.0.1:${process.env.BROWSER_PREVIEW_PORT ?? 5187}`;

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
    { name: 'dev', use: { baseURL: devURL } },
    { name: 'production', use: { baseURL: productionURL } },
  ],
  webServer: [
    {
      command: 'node scripts/browser-server.mjs dev',
      url: devURL,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'node scripts/browser-server.mjs production',
      url: productionURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
