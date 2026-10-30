import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// A separate, opt-in demonstration. Never part of the deterministic regression.
const output =
  process.env.BROWSER_REAL_OUTPUT ??
  `test-results/real-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
export default defineConfig({
  ...base,
  testMatch:
    process.env.REAL_AGENT_PROVIDER === 'deepseek'
      ? process.env.REAL_AGENT_FLOW === 'multi_turn_delivery'
        ? '**/deepseek-multiturn.real.spec.ts'
        : '**/deepseek-page.real.spec.ts'
      : '**/real.spec.ts',
  timeout: 900_000,
  projects: [base.projects![1]],
  webServer: (base.webServer as any[])[1],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
  use: { ...base.use, headless: false },
});
