import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import base from './playwright.config.ts';

// A separate, opt-in demonstration. Never part of the deterministic regression.
const flow = process.env.REAL_AGENT_FLOW;
const human = flow === 'human_acceptance';
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
// Playwright reloads this config in workers. Inherit the parent run's name.
const output = human
  ? `.qa/human-agent/runs/${(process.env.HUMAN_AGENT_RUN_ID ??= `${stamp}-${randomUUID()}`)}`
  : (process.env.BROWSER_REAL_OUTPUT ?? `test-results/real-${stamp}`);
const provider = process.env.REAL_AGENT_PROVIDER ?? 'ollama';
if (human && (!process.env.HUMAN_VIDEO_PATH?.trim() || provider !== 'ollama'))
  throw new Error('human_acceptance requires HUMAN_VIDEO_PATH and REAL_AGENT_PROVIDER=ollama');
if (human && !/^[\w-]+$/.test(process.env.HUMAN_AGENT_RUN_ID!))
  throw new Error('Invalid human acceptance run name');

export default defineConfig({
  ...base,
  testMatch: human
    ? '**/human-agent.real.spec.ts'
    : flow === 'rom_task_card'
      ? '**/rom-task-card.real.spec.ts'
      : provider === 'ollama'
        ? '**/real.spec.ts'
        : provider === 'deepseek' && flow !== 'multi_turn_delivery'
          ? '**/deepseek-page.real.spec.ts'
          : '**/deepseek-multiturn.real.spec.ts',
  timeout: 900_000,
  projects: [base.projects![1]],
  webServer: human ? undefined : (base.webServer as any[])[1],
  globalSetup: human ? './scripts/browser-server.mjs' : undefined,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/results.json` }]],
  use: {
    ...base.use,
    channel: base.use?.channel ?? (human ? 'chrome' : undefined),
    headless: false,
  },
});
