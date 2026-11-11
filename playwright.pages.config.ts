import { defineConfig } from '@playwright/test';
import browser from './playwright.config';

const baseURL = 'http://127.0.0.1:5188/cnzjz/';

// Serve the exact dist that the Pages job will upload, without Vite fallbacks or proxies.
export default defineConfig({
  ...browser,
  testMatch: /(?:^|[\\/])(?:flows|pages\.flows)\.spec\.ts$/,
  grep: process.env.HUMAN_VIDEO_PATH ? /@pages|authorized human video/ : /@pages/,
  outputDir: 'test-results/pages',
  reporter: [['list'], ['json', { outputFile: 'test-results/pages-results.json' }]],
  projects: [{ name: 'pages', use: { baseURL, channel: 'chrome' } }],
  webServer: {
    command: 'node scripts/pages-smoke-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
  },
});
