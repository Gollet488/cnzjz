import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// A separate, opt-in demonstration. Never part of the deterministic regression.
const output =
  process.env.BROWSER_REAL_OUTPUT ??
  `test-results/real-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
const provider = process.env.REAL_AGENT_PROVIDER ?? 'ollama';
export default defineConfig({
  ...base,
  testMatch:
    process.env.REAL_AGENT_FLOW === 'rom_task_card'
      ? '**/rom-task-card.real.spec.ts'
      : provider === 'ollama'
        ? '**/real.spec.ts'
        : provider === 'deepseek' && process.env.REAL_AGENT_FLOW !== 'multi_turn_delivery'
          ? '**/deepseek-page.real.spec.ts'
          : '**/deepseek-multiturn.real.spec.ts',
  timeout: 900_000,
  projects: [base.projects![1]],
  webServer: (base.webServer as any[])[1],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
  use: { ...base.use, headless: false },
});
